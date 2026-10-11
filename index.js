(function () {
    // MessageLogger (local) — плагин для Kettu (формат Vendetta).
    // Kettu выполняет код как `return <файл>`, поэтому файл обязан начинаться с "(" — без комментариев сверху.
    // Пишется на "плоском" JS без классов/async/let/const: код исполняется через eval в Hermes без транспиляции.
    var V = vendetta;
    var metro = V.metro;
    var common = metro.common;
    var React = common.React;
    var RN = common.ReactNative;
    var FluxDispatcher = common.FluxDispatcher;
    var patcher = V.patcher;
    var storage = V.plugin.storage;
    var logger = V.logger;
    var useProxy = V.storage.useProxy;
    var showToast = V.ui.toasts.showToast;
    var getAssetIDByName = V.ui.assets.getAssetIDByName;
    var semanticColors = V.ui.semanticColors || {};
    var h = React.createElement;

    var MessageStore = metro.findByStoreName("MessageStore");
    var ChannelStore = metro.findByStoreName("ChannelStore");
    var GuildStore = metro.findByStoreName("GuildStore");
    var UserStore = metro.findByStoreName("UserStore");

    var DEFAULTS = {
        keepInChat: true,       // не убирать удалённые из чата (и возвращать их после перезапуска)
        highlight: true,        // подсвечивать удалённые красным
        logEdits: true,         // логировать правки
        ignoreSelf: false,      // не логировать свои сообщения
        ignoreBots: false,      // не логировать ботов
        saveAttachments: true,  // пытаться скачать вложения удалённых сообщений
        maxEntries: 3000        // лимит записей (старые удаляются)
    };
    var MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
    var RAW_CACHE_MAX = 5000;
    var AUTOMOD_EVENT = "MESSAGE_EDIT_FAILED_AUTOMOD";
    var DELETED_COLOR = "#da373c";

    // ───────────────────────── Файловое хранилище ─────────────────────────

    function getNativeModule(names) {
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (globalThis.__turboModuleProxy) {
                var m = globalThis.__turboModuleProxy(name);
                if (m) return m;
            }
            if (globalThis.nativeModuleProxy && globalThis.nativeModuleProxy[name]) return globalThis.nativeModuleProxy[name];
            if (RN.NativeModules && RN.NativeModules[name]) return RN.NativeModules[name];
        }
        return null;
    }

    var FM = getNativeModule(["NativeFileModule", "RTNFileManager", "DCDFileManager"]);
    var DIR = "MessageLogger";
    var DB_FILE = DIR + "/log.json";

    // То же, что делает сам Kettu: на iOS без saveFileToGallery путь нужно предварять "Documents/"
    function fixPath(p) {
        return RN.Platform.OS === "ios" && !FM.saveFileToGallery ? "Documents/" + p : p;
    }
    function fullPath(p) {
        return FM.getConstants().DocumentsDirPath + "/" + p;
    }
    function writeFile(p, data, encoding) {
        return FM.writeFile("documents", fixPath(p), data, encoding || "utf8");
    }
    function readFile(p) {
        return FM.fileExists(fullPath(p)).then(function (exists) {
            return exists ? FM.readFile(fullPath(p), "utf8") : null;
        });
    }
    function removeFile(p) {
        try {
            if (FM.removeFile) FM.removeFile("documents", fixPath(p));
        } catch (e) { }
    }

    var db = { version: 1, deleted: {}, edits: {} };
    var dbLoaded = false;
    var saveTimer = null;
    var listeners = new Set();

    function emitChange() {
        listeners.forEach(function (fn) {
            try { fn(); } catch (e) { }
        });
    }

    function loadDb() {
        return readFile(DB_FILE).then(function (text) {
            var loaded = null;
            if (text) {
                try { loaded = JSON.parse(text); } catch (e) {
                    logger.error("MessageLogger: log.json повреждён, создаю резервную копию", e);
                    writeFile(DIR + "/log.broken-" + Date.now() + ".json", text);
                }
            }
            if (loaded && loaded.deleted) {
                // То, что успели поймать до загрузки файла, имеет приоритет
                db.deleted = Object.assign(loaded.deleted, db.deleted);
                db.edits = Object.assign(loaded.edits || {}, db.edits);
            }
            dbLoaded = true;
            flushSave();
        }).catch(function (e) {
            logger.error("MessageLogger: не удалось прочитать лог", e);
            dbLoaded = true;
        });
    }

    function scheduleSave() {
        emitChange();
        if (!dbLoaded || saveTimer) return;
        saveTimer = setTimeout(flushSave, 1000);
    }

    function flushSave() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        if (!dbLoaded || !FM) return;
        prune();
        writeFile(DB_FILE, JSON.stringify(db)).catch(function (e) {
            logger.error("MessageLogger: не удалось сохранить лог", e);
        });
        emitChange();
    }

    function pruneMap(map, timeKey) {
        var max = Number(storage.maxEntries) || DEFAULTS.maxEntries;
        var ids = Object.keys(map);
        if (ids.length <= max) return;
        ids.sort(function (a, b) { return (map[a][timeKey] || 0) - (map[b][timeKey] || 0); });
        ids.slice(0, ids.length - max).forEach(function (id) {
            removeEntryFiles(map[id]);
            delete map[id];
        });
    }

    function prune() {
        pruneMap(db.deleted, "deletedAt");
        pruneMap(db.edits, "updatedAt");
    }

    function removeEntryFiles(entry) {
        if (!entry || !entry.files) return;
        Object.keys(entry.files).forEach(function (k) { removeFile(entry.files[k]); });
    }

    // ───────────────────────── Утилиты ─────────────────────────

    // Сравнение snowflake-ID без BigInt
    function cmpId(a, b) {
        a = String(a); b = String(b);
        if (a.length !== b.length) return a.length - b.length;
        return a < b ? -1 : a > b ? 1 : 0;
    }

    function snowflakeTime(id) {
        try {
            return Number(BigInt(id) >> BigInt(22)) + 1420070400000;
        } catch (e) {
            return Date.now();
        }
    }

    function toIso(t) {
        if (!t) return null;
        if (typeof t === "string") return t;
        if (typeof t === "number") return new Date(t).toISOString();
        if (typeof t.toISOString === "function") return t.toISOString();
        return null;
    }

    function pad(n) { return n < 10 ? "0" + n : String(n); }
    function formatDate(ts) {
        var d = new Date(ts);
        return pad(d.getDate()) + "." + pad(d.getMonth() + 1) + "." + d.getFullYear() + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }

    function authorName(author) {
        if (!author) return "Неизвестно";
        return author.global_name || author.globalName || author.username || author.id;
    }

    function avatarUrl(author) {
        if (!author || !author.id) return null;
        if (author.avatar) return "https://cdn.discordapp.com/avatars/" + author.id + "/" + author.avatar + ".png?size=64";
        return "https://cdn.discordapp.com/embed/avatars/0.png";
    }

    function describeChannel(channelId, guildId) {
        var ch = null;
        try { ch = ChannelStore && ChannelStore.getChannel(channelId); } catch (e) { }
        var gid = guildId || (ch && ch.guild_id) || null;
        var guild = null;
        try { guild = gid && GuildStore ? GuildStore.getGuild(gid) : null; } catch (e) { }

        var channelName = null;
        if (ch) {
            if (ch.name) {
                channelName = (gid ? "#" : "") + ch.name;
            } else if (ch.recipients && ch.recipients.length) {
                channelName = ch.recipients.map(function (uid) {
                    var u = UserStore && UserStore.getUser(uid);
                    return u ? (u.globalName || u.username) : uid;
                }).join(", ");
            }
        }

        return {
            guildId: gid,
            guildName: guild ? guild.name : (gid ? null : "Личные сообщения"),
            channelName: channelName
        };
    }

    function whereText(entry) {
        // Пытаемся взять актуальные имена, иначе — сохранённые на момент удаления
        var live = describeChannel(entry.channelId, entry.guildId);
        var guildName = live.guildName || entry.guildName || entry.guildId || "?";
        var channelName = live.channelName || entry.channelName || entry.channelId;
        return guildName + " › " + channelName;
    }

    // Превращает запись из MessageStore в "сырой" объект API (формат, который понимает LOAD_MESSAGES_SUCCESS)
    function recordToRaw(m, channelId, guildId) {
        var a = m.author || {};
        var raw = {
            id: m.id,
            channel_id: m.channel_id || channelId,
            type: m.type || 0,
            content: m.content || "",
            author: {
                id: a.id,
                username: a.username,
                global_name: a.globalName != null ? a.globalName : a.global_name,
                avatar: a.avatar,
                discriminator: a.discriminator || "0",
                bot: !!a.bot,
                public_flags: a.publicFlags || 0
            },
            timestamp: toIso(m.timestamp) || new Date(snowflakeTime(m.id)).toISOString(),
            edited_timestamp: toIso(m.editedTimestamp),
            attachments: (m.attachments || []).map(function (x) {
                return {
                    id: x.id, filename: x.filename, size: x.size, url: x.url, proxy_url: x.proxy_url,
                    width: x.width, height: x.height, content_type: x.content_type
                };
            }),
            embeds: [],
            mentions: [],
            mention_roles: [],
            mention_everyone: false,
            pinned: false,
            tts: false,
            flags: m.flags || 0
        };
        if (guildId) raw.guild_id = guildId;
        if (m.messageReference) {
            raw.message_reference = {
                message_id: m.messageReference.message_id,
                channel_id: m.messageReference.channel_id,
                guild_id: m.messageReference.guild_id
            };
        }
        if (m.stickerItems && m.stickerItems.length) raw.sticker_items = m.stickerItems;
        return raw;
    }

    // Кэш "сырых" сообщений из гейтвея — так ловятся удаления даже в неоткрытых чатах
    var rawCache = new Map();
    function cacheRaw(m) {
        if (!m || !m.id) return;
        if (rawCache.has(m.id)) rawCache.delete(m.id);
        rawCache.set(m.id, m);
        if (rawCache.size > RAW_CACHE_MAX) rawCache.delete(rawCache.keys().next().value);
    }

    function currentUserId() {
        try {
            var me = UserStore.getCurrentUser();
            return me && me.id;
        } catch (e) {
            return null;
        }
    }

    function shouldSkip(author, record, flags) {
        if (flags & 64) return true; // эфемерные сообщения
        if (record && record.state && record.state !== "SENT") return true; // неотправленные/локальные
        if (storage.ignoreSelf && author && author.id === currentUserId()) return true;
        if (storage.ignoreBots && author && author.bot) return true;
        return false;
    }

    // ───────────────────────── Вложения ─────────────────────────

    function safeName(s) {
        return String(s || "file").replace(/[^\w.\-]/g, "_").slice(-80);
    }

    function downloadToFile(url, rel) {
        return fetch(url).then(function (r) {
            if (!r.ok) throw new Error("HTTP " + r.status);
            return r.blob();
        }).then(function (blob) {
            return new Promise(function (resolve, reject) {
                var fr = new FileReader();
                fr.onload = function () { resolve(String(fr.result)); };
                fr.onerror = reject;
                fr.readAsDataURL(blob);
            });
        }).then(function (dataUrl) {
            return writeFile(rel, dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        });
    }

    function downloadAttachments(entry) {
        if (!storage.saveAttachments || !FM) return;
        var atts = (entry.raw && entry.raw.attachments) || [];
        atts.forEach(function (att) {
            if (!att || !att.id || (att.size && att.size > MAX_ATTACHMENT_SIZE)) return;
            var url = att.proxy_url || att.url;
            if (!url) return;
            var rel = DIR + "/files/" + entry.id + "_" + att.id + "_" + safeName(att.filename);
            downloadToFile(url, rel).then(function () {
                if (db.deleted[entry.id] !== entry) return removeFile(rel);
                entry.files = entry.files || {};
                entry.files[att.id] = rel;
                scheduleSave();
            }).catch(function (e) {
                logger.log("MessageLogger: вложение " + att.filename + " не скачалось: " + (e && e.message));
            });
        });
    }

    // ───────────────────────── Логика удалений/правок ─────────────────────────

    function noteText(entry) {
        return "Сообщение удалено · " + formatDate(entry.deletedAt);
    }

    // Этим событием Discord сам рисует красную подпись под сообщением, не удаляя его
    function markEvent(entry) {
        return {
            type: AUTOMOD_EVENT,
            messageData: { type: 1, message: { channelId: entry.channelId, messageId: entry.id } },
            errorResponseBody: { code: 200000, message: noteText(entry) }
        };
    }

    function dispatchLater(events) {
        if (!events.length) return;
        setTimeout(function () {
            events.forEach(function (ev) {
                try { FluxDispatcher.dispatch(ev); } catch (e) { logger.error("MessageLogger: dispatch", e); }
            });
        }, 0);
    }

    function handleDelete(channelId, id, guildId) {
        if (!channelId || !id) return null;
        var record = null;
        try { record = MessageStore.getMessage(channelId, id); } catch (e) { }

        var existing = db.deleted[id];
        if (existing) return { entry: existing, inStore: !!record };

        var raw = rawCache.get(id);
        if (!raw && record) raw = recordToRaw(record, channelId, guildId);
        if (!raw) return null;
        if (record && typeof record.content === "string") raw = Object.assign({}, raw, { content: record.content });
        if (!raw.channel_id) raw = Object.assign({}, raw, { channel_id: channelId });

        if (shouldSkip(raw.author, record, (record && record.flags) || raw.flags || 0)) return null;

        var where = describeChannel(channelId, guildId || raw.guild_id);
        var entry = {
            id: id,
            channelId: channelId,
            guildId: where.guildId,
            guildName: where.guildName,
            channelName: where.channelName,
            deletedAt: Date.now(),
            raw: raw,
            files: {}
        };
        db.deleted[id] = entry;
        downloadAttachments(entry);
        scheduleSave();
        return { entry: entry, inStore: !!record };
    }

    function handleUpdate(ev) {
        var m = ev.message;
        if (!m || !m.id) return;
        var cached = rawCache.get(m.id);
        var record = null;
        try { record = MessageStore.getMessage(m.channel_id, m.id); } catch (e) { }
        var oldContent = record ? record.content : cached ? cached.content : undefined;

        if (storage.logEdits && typeof m.content === "string" && typeof oldContent === "string" && oldContent !== m.content) {
            var author = m.author || (cached && cached.author) || (record && record.author && { id: record.author.id, username: record.author.username, global_name: record.author.globalName, avatar: record.author.avatar, bot: record.author.bot });
            if (!shouldSkip(author, null, m.flags || 0)) {
                var e = db.edits[m.id];
                if (!e) {
                    var where = describeChannel(m.channel_id, m.guild_id);
                    e = db.edits[m.id] = {
                        id: m.id,
                        channelId: m.channel_id,
                        guildId: where.guildId,
                        guildName: where.guildName,
                        channelName: where.channelName,
                        author: author ? { id: author.id, username: author.username, global_name: author.global_name || author.globalName, avatar: author.avatar, bot: !!author.bot } : null,
                        history: []
                    };
                }
                e.history.push({ content: oldContent, replacedAt: Date.now() });
                e.current = m.content;
                e.updatedAt = Date.now();
                scheduleSave();
            }
        }

        if (cached) cacheRaw(Object.assign({}, cached, m));
    }

    // Возвращаем сохранённые удалённые сообщения в загружаемую пачку — так они "живут" в чате после перезапуска
    function handleLoad(ev) {
        var channelId = ev.channelId;
        var msgs = ev.messages;
        if (!channelId || !Array.isArray(msgs)) return;
        msgs.forEach(cacheRaw);
        if (!storage.keepInChat) return;

        var candidates = [];
        for (var id in db.deleted) {
            var en = db.deleted[id];
            if (en.channelId === channelId && en.raw) candidates.push(en);
        }
        if (!candidates.length) return;

        var present = {};
        var newest = null, oldest = null;
        msgs.forEach(function (m) {
            present[m.id] = true;
            if (newest === null || cmpId(m.id, newest) > 0) newest = m.id;
            if (oldest === null || cmpId(m.id, oldest) < 0) oldest = m.id;
        });

        var storeFirst = null, storeLast = null;
        try {
            var cm = MessageStore.getMessages(channelId);
            if (cm && typeof cm.first === "function") storeFirst = cm.first();
            if (cm && typeof cm.last === "function") storeLast = cm.last();
        } catch (e) { }

        // Границы (исключающие), в которые должны попасть вставляемые сообщения; null = без границы
        var lo, hi;
        if (ev.isBefore) {
            lo = ev.hasMoreBefore ? oldest : null;
            hi = storeFirst ? storeFirst.id : newest;
        } else if (ev.isAfter) {
            lo = storeLast ? storeLast.id : oldest;
            hi = ev.hasMoreAfter ? newest : null;
        } else {
            lo = ev.hasMoreBefore ? oldest : null;
            hi = ev.hasMoreAfter ? newest : null;
        }
        var incremental = !!(ev.isBefore || ev.isAfter);

        var inject = candidates.filter(function (en) {
            if (present[en.id]) return false;
            if (lo !== null && lo !== undefined && cmpId(en.id, lo) <= 0) return false;
            if (hi !== null && hi !== undefined && cmpId(en.id, hi) >= 0) return false;
            if (incremental) {
                try { if (MessageStore.getMessage(channelId, en.id)) return false; } catch (e) { }
            }
            return true;
        });
        if (!inject.length) return;

        ev.messages = msgs.concat(inject.map(function (en) { return en.raw; }))
            .sort(function (a, b) { return cmpId(b.id, a.id); });
        dispatchLater(inject.map(markEvent));
    }

    function onDispatch(args) {
        var ev = args[0];
        if (!ev || typeof ev.type !== "string") return;
        try {
            switch (ev.type) {
                case "MESSAGE_CREATE":
                    cacheRaw(ev.message);
                    break;
                case "MESSAGE_UPDATE":
                    handleUpdate(ev);
                    break;
                case "MESSAGE_DELETE": {
                    var res = handleDelete(ev.channelId, ev.id, ev.guildId);
                    if (res && res.inStore && storage.keepInChat) args[0] = markEvent(res.entry);
                    break;
                }
                case "MESSAGE_DELETE_BULK": {
                    var keep = [], rest = [];
                    (ev.ids || []).forEach(function (mid) {
                        var r = handleDelete(ev.channelId, mid, ev.guildId);
                        if (r && r.inStore && storage.keepInChat) keep.push(r.entry);
                        else rest.push(mid);
                    });
                    if (keep.length) {
                        args[0] = Object.assign({}, ev, { ids: rest });
                        dispatchLater(keep.map(markEvent));
                    }
                    break;
                }
                case "LOAD_MESSAGES_SUCCESS":
                case "LOCAL_MESSAGES_LOADED":
                    handleLoad(ev);
                    break;
            }
        } catch (e) {
            logger.error("MessageLogger: ошибка в обработчике " + ev.type, e);
        }
    }

    // ───────────────────────── Навигация ─────────────────────────

    function messageLink(entry) {
        return "https://discord.com/channels/" + (entry.guildId || "@me") + "/" + entry.channelId + "/" + entry.id;
    }

    function jumpTo(entry) {
        try {
            var router = metro.findByProps("transitionToGuild");
            if (router) {
                router.transitionToGuild(entry.guildId || "@me", entry.channelId, entry.id);
                showToast("Открываю чат — вернитесь из настроек", getAssetIDByName("ic_message_retry"));
                return;
            }
        } catch (e) { }
        try {
            common.url.openURL(messageLink(entry));
        } catch (e) {
            common.clipboard.setString(messageLink(entry));
            showToast("Ссылка скопирована", getAssetIDByName("toast_copy_link"));
        }
    }

    function removeEntry(kind, id) {
        var map = kind === "edits" ? db.edits : db.deleted;
        removeEntryFiles(map[id]);
        delete map[id];
        scheduleSave();
    }

    // ───────────────────────── UI ─────────────────────────

    var C = {
        text: semanticColors.TEXT_NORMAL || semanticColors.TEXT_DEFAULT,
        muted: semanticColors.TEXT_MUTED,
        header: semanticColors.HEADER_PRIMARY || semanticColors.TEXT_NORMAL,
        card: semanticColors.BACKGROUND_SECONDARY,
        input: semanticColors.BACKGROUND_TERTIARY || semanticColors.BACKGROUND_SECONDARY_ALT,
        link: semanticColors.TEXT_LINK
    };

    var styles = common.stylesheet.createThemedStyleSheet({
        tabs: { flexDirection: "row", marginHorizontal: 12, marginTop: 12, borderRadius: 10, padding: 3, backgroundColor: C.card },
        tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
        tabActive: { backgroundColor: C.input },
        tabText: { color: C.muted, fontSize: 14, fontWeight: "600" },
        tabTextActive: { color: C.header },
        search: { marginHorizontal: 12, marginTop: 10, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, fontSize: 15, color: C.text, backgroundColor: C.card },
        chip: { flexDirection: "row", alignSelf: "flex-start", marginHorizontal: 12, marginTop: 8, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, backgroundColor: C.card },
        chipText: { color: C.header, fontSize: 13 },
        card: { marginHorizontal: 12, marginTop: 10, padding: 12, borderRadius: 12, backgroundColor: C.card, borderLeftWidth: 3, borderLeftColor: DELETED_COLOR },
        cardEdit: { borderLeftColor: "#f0b232" },
        row: { flexDirection: "row", alignItems: "center" },
        avatar: { width: 32, height: 32, borderRadius: 16, marginRight: 10 },
        author: { color: C.header, fontSize: 15, fontWeight: "700" },
        meta: { color: C.muted, fontSize: 12, marginTop: 1 },
        content: { color: C.text, fontSize: 15, marginTop: 8 },
        oldContent: { color: C.muted, fontSize: 14, marginTop: 6, textDecorationLine: "line-through" },
        attachment: { color: C.link, fontSize: 13, marginTop: 6 },
        image: { width: 220, height: 160, borderRadius: 8, marginTop: 8, resizeMode: "cover" },
        footer: { color: C.muted, fontSize: 12, marginTop: 8 },
        empty: { color: C.muted, textAlign: "center", marginTop: 40, fontSize: 15 },
        section: { color: C.muted, fontSize: 12, fontWeight: "700", marginHorizontal: 16, marginTop: 18, marginBottom: 4 },
        setting: { flexDirection: "row", alignItems: "center", marginHorizontal: 12, marginTop: 6, padding: 12, borderRadius: 12, backgroundColor: C.card },
        settingLabel: { color: C.header, fontSize: 15, fontWeight: "600" },
        settingSub: { color: C.muted, fontSize: 12, marginTop: 2 },
        button: { marginHorizontal: 12, marginTop: 8, padding: 12, borderRadius: 12, alignItems: "center", backgroundColor: C.card },
        buttonText: { color: C.header, fontSize: 15, fontWeight: "600" },
        dangerText: { color: DELETED_COLOR, fontSize: 15, fontWeight: "600" },
        limits: { flexDirection: "row", marginHorizontal: 12, marginTop: 6 },
        limit: { flex: 1, marginHorizontal: 3, paddingVertical: 8, borderRadius: 10, alignItems: "center", backgroundColor: C.card },
        limitActive: { backgroundColor: "#5865f2" },
        limitText: { color: C.header, fontSize: 14 },
        limitTextActive: { color: "#ffffff", fontWeight: "700" }
    });

    function useDb() {
        var state = React.useState(0);
        var bump = state[1];
        React.useEffect(function () {
            var fn = function () { bump(function (n) { return n + 1; }); };
            listeners.add(fn);
            return function () { listeners.delete(fn); };
        }, []);
        return db;
    }

    function matches(q, parts) {
        if (!q) return true;
        q = q.toLowerCase();
        return parts.some(function (p) { return p && String(p).toLowerCase().indexOf(q) !== -1; });
    }

    function showEntryActions(kind, entry, text) {
        RN.Alert.alert("Действия", null, [
            { text: "Перейти", onPress: function () { jumpTo(entry); } },
            {
                text: "Копировать", onPress: function () {
                    common.clipboard.setString(text || "");
                    showToast("Текст скопирован", getAssetIDByName("toast_copy_link"));
                }
            },
            {
                text: "Ещё…", onPress: function () {
                    RN.Alert.alert("Ещё", null, [
                        {
                            text: "Копировать ссылку", onPress: function () {
                                common.clipboard.setString(messageLink(entry));
                                showToast("Ссылка скопирована", getAssetIDByName("toast_copy_link"));
                            }
                        },
                        { text: "Удалить из лога", style: "destructive", onPress: function () { removeEntry(kind, entry.id); } }
                    ], { cancelable: true });
                }
            }
        ], { cancelable: true });
    }

    function Header(props) {
        var author = props.author;
        var uri = avatarUrl(author);
        return h(RN.View, { style: styles.row },
            uri ? h(RN.Image, { source: { uri: uri }, style: styles.avatar }) : null,
            h(RN.View, { style: { flex: 1 } },
                h(RN.Text, { style: styles.author, numberOfLines: 1 }, authorName(author) + (author && author.bot ? " [BOT]" : "")),
                h(RN.Text, { style: styles.meta, numberOfLines: 1 }, props.where)
            )
        );
    }

    function DeletedCard(props) {
        var entry = props.entry;
        var raw = entry.raw || {};
        var atts = raw.attachments || [];
        var files = entry.files || {};
        var embedsCount = (raw.embeds || []).length;
        var stickers = raw.sticker_items || [];

        return h(RN.TouchableOpacity, {
            activeOpacity: 0.7,
            onPress: function () { showEntryActions("deleted", entry, raw.content); },
            style: styles.card
        },
            h(Header, { author: raw.author, where: whereText(entry) }),
            raw.content ? h(RN.Text, { style: styles.content, selectable: true }, raw.content) : null,
            atts.map(function (att) {
                var local = files[att.id];
                var isImage = /^image\//.test(att.content_type || "") || /\.(png|jpe?g|gif|webp)$/i.test(att.filename || "");
                if (local && isImage) {
                    return h(RN.Image, { key: att.id, source: { uri: "file://" + fullPath(local) }, style: styles.image });
                }
                return h(RN.Text, {
                    key: att.id,
                    style: styles.attachment,
                    onPress: function () { common.url.openURL(local ? "file://" + fullPath(local) : att.url); }
                }, "📎 " + (att.filename || "вложение") + (local ? " (сохранено)" : " (только ссылка)"));
            }),
            stickers.length ? h(RN.Text, { style: styles.meta }, "Стикер: " + stickers.map(function (s) { return s.name; }).join(", ")) : null,
            embedsCount ? h(RN.Text, { style: styles.meta }, "Эмбедов: " + embedsCount) : null,
            h(RN.Text, { style: styles.footer },
                "Отправлено " + formatDate(raw.timestamp ? Date.parse(raw.timestamp) : snowflakeTime(entry.id)) + " · удалено " + formatDate(entry.deletedAt))
        );
    }

    function EditCard(props) {
        var entry = props.entry;
        return h(RN.TouchableOpacity, {
            activeOpacity: 0.7,
            onPress: function () { showEntryActions("edits", entry, entry.current); },
            style: [styles.card, styles.cardEdit]
        },
            h(Header, { author: entry.author, where: whereText(entry) }),
            entry.history.map(function (v, i) {
                return h(RN.Text, { key: i, style: styles.oldContent, selectable: true }, v.content || "(пусто)");
            }),
            h(RN.Text, { style: styles.content, selectable: true }, entry.current || "(пусто)"),
            h(RN.Text, { style: styles.footer }, "Правок: " + entry.history.length + " · последняя " + formatDate(entry.updatedAt))
        );
    }

    function ChannelRow(props) {
        var g = props.group;
        return h(RN.TouchableOpacity, { activeOpacity: 0.7, onPress: props.onPress, style: styles.setting },
            h(RN.View, { style: { flex: 1 } },
                h(RN.Text, { style: styles.settingLabel, numberOfLines: 1 }, g.where),
                h(RN.Text, { style: styles.settingSub }, "Последнее удаление: " + formatDate(g.last))
            ),
            h(RN.Text, { style: styles.dangerText }, String(g.count))
        );
    }

    function SettingSwitch(props) {
        return h(RN.View, { style: styles.setting },
            h(RN.View, { style: { flex: 1, marginRight: 8 } },
                h(RN.Text, { style: styles.settingLabel }, props.label),
                props.sub ? h(RN.Text, { style: styles.settingSub }, props.sub) : null
            ),
            h(RN.Switch, {
                value: !!storage[props.k],
                onValueChange: function (v) { storage[props.k] = v; }
            })
        );
    }

    function Button(props) {
        return h(RN.TouchableOpacity, { activeOpacity: 0.7, onPress: props.onPress, style: styles.button },
            h(RN.Text, { style: props.danger ? styles.dangerText : styles.buttonText }, props.label));
    }

    function exportLog() {
        RN.Share.share({ title: "MessageLogger", message: JSON.stringify(db, null, 1) }).catch(function (e) {
            showToast("Не удалось поделиться: " + (e && e.message));
        });
    }

    function SettingsTab(props) {
        useProxy(storage);
        var deletedCount = Object.keys(db.deleted).length;
        var editCount = Object.keys(db.edits).length;

        return h(RN.ScrollView, { contentContainerStyle: { paddingBottom: 40 } },
            h(RN.Text, { style: styles.section }, "В ЧАТЕ"),
            h(SettingSwitch, { k: "keepInChat", label: "Оставлять удалённые в чате", sub: "Сообщения не пропадают и возвращаются на место после перезапуска" }),
            h(SettingSwitch, { k: "highlight", label: "Подсвечивать удалённые", sub: "Красный фон и полоска слева" }),
            h(RN.Text, { style: styles.section }, "ЛОГИРОВАНИЕ"),
            h(SettingSwitch, { k: "logEdits", label: "Логировать правки" }),
            h(SettingSwitch, { k: "saveAttachments", label: "Скачивать вложения", sub: "Пытается сохранить файлы удалённых сообщений (до 10 МБ). Discord может успеть удалить их с CDN" }),
            h(SettingSwitch, { k: "ignoreSelf", label: "Игнорировать свои сообщения" }),
            h(SettingSwitch, { k: "ignoreBots", label: "Игнорировать ботов" }),
            h(RN.Text, { style: styles.section }, "ЛИМИТ ЗАПИСЕЙ (КАЖДОГО ТИПА)"),
            h(RN.View, { style: styles.limits },
                [500, 3000, 10000, 30000].map(function (n) {
                    var active = Number(storage.maxEntries) === n;
                    return h(RN.TouchableOpacity, {
                        key: n,
                        onPress: function () { storage.maxEntries = n; scheduleSave(); },
                        style: [styles.limit, active && styles.limitActive]
                    }, h(RN.Text, { style: [styles.limitText, active && styles.limitTextActive] }, String(n)));
                })
            ),
            h(RN.Text, { style: styles.section }, "ДАННЫЕ"),
            h(RN.Text, { style: [styles.settingSub, { marginHorizontal: 16 }], selectable: true },
                "Удалённых: " + deletedCount + " · правок: " + editCount + "\nФайл: " + (FM ? fullPath(DB_FILE) : "файловый модуль недоступен")),
            h(Button, { label: "Экспорт (поделиться JSON)", onPress: exportLog }),
            h(Button, {
                label: "Очистить лог", danger: true, onPress: function () {
                    RN.Alert.alert("Очистить лог?", "Все сохранённые удалённые сообщения и правки будут стёрты.", [
                        { text: "Отмена", style: "cancel" },
                        {
                            text: "Очистить", style: "destructive", onPress: function () {
                                Object.keys(db.deleted).forEach(function (id) { removeEntryFiles(db.deleted[id]); });
                                db.deleted = {};
                                db.edits = {};
                                flushSave();
                            }
                        }
                    ]);
                }
            })
        );
    }

    function Settings() {
        useDb();
        var tabState = React.useState("deleted");
        var tab = tabState[0], setTab = tabState[1];
        var qState = React.useState("");
        var query = qState[0], setQuery = qState[1];
        var chState = React.useState(null);
        var channelFilter = chState[0], setChannelFilter = chState[1];

        var tabs = [
            { id: "deleted", label: "Удалённые" },
            { id: "edits", label: "Правки" },
            { id: "chats", label: "По чатам" },
            { id: "settings", label: "Настройки" }
        ];

        var body;
        if (tab === "settings") {
            body = h(SettingsTab);
        } else {
            var data = [];
            var renderItem;
            if (tab === "deleted") {
                data = Object.keys(db.deleted).map(function (id) { return db.deleted[id]; })
                    .filter(function (e) {
                        if (channelFilter && e.channelId !== channelFilter) return false;
                        var raw = e.raw || {};
                        return matches(query, [raw.content, authorName(raw.author), e.channelName, e.guildName]);
                    })
                    .sort(function (a, b) { return b.deletedAt - a.deletedAt; });
                renderItem = function (it) { return h(DeletedCard, { entry: it.item }); };
            } else if (tab === "edits") {
                data = Object.keys(db.edits).map(function (id) { return db.edits[id]; })
                    .filter(function (e) {
                        if (channelFilter && e.channelId !== channelFilter) return false;
                        return matches(query, [e.current, authorName(e.author), e.channelName, e.guildName].concat(e.history.map(function (v) { return v.content; })));
                    })
                    .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
                renderItem = function (it) { return h(EditCard, { entry: it.item }); };
            } else {
                var groups = {};
                Object.keys(db.deleted).forEach(function (id) {
                    var e = db.deleted[id];
                    var g = groups[e.channelId] || (groups[e.channelId] = { id: e.channelId, entry: e, count: 0, last: 0 });
                    g.count++;
                    if (e.deletedAt > g.last) { g.last = e.deletedAt; g.entry = e; }
                });
                data = Object.keys(groups).map(function (k) {
                    var g = groups[k];
                    g.where = whereText(g.entry);
                    return g;
                }).filter(function (g) { return matches(query, [g.where]); })
                    .sort(function (a, b) { return b.last - a.last; });
                renderItem = function (it) {
                    return h(ChannelRow, {
                        group: it.item,
                        onPress: function () { setChannelFilter(it.item.id); setTab("deleted"); }
                    });
                };
            }

            var filterEntry = channelFilter && (db.deleted[Object.keys(db.deleted).find(function (id) { return db.deleted[id].channelId === channelFilter; })]);

            body = h(RN.View, { style: { flex: 1 } },
                h(RN.TextInput, {
                    style: styles.search,
                    placeholder: "Поиск по тексту, автору, каналу",
                    placeholderTextColor: "#8e9297",
                    value: query,
                    onChangeText: setQuery
                }),
                channelFilter && tab !== "chats" ? h(RN.TouchableOpacity, { style: styles.chip, onPress: function () { setChannelFilter(null); } },
                    h(RN.Text, { style: styles.chipText }, "✕  " + (filterEntry ? whereText(filterEntry) : channelFilter))) : null,
                h(RN.FlatList, {
                    data: data,
                    keyExtractor: function (it) { return it.id; },
                    renderItem: renderItem,
                    initialNumToRender: 10,
                    windowSize: 7,
                    contentContainerStyle: { paddingBottom: 40 },
                    ListEmptyComponent: h(RN.Text, { style: styles.empty }, query ? "Ничего не найдено" : "Пока пусто")
                })
            );
        }

        return h(RN.View, { style: { flex: 1 } },
            h(RN.View, { style: styles.tabs },
                tabs.map(function (t) {
                    var active = t.id === tab;
                    return h(RN.TouchableOpacity, {
                        key: t.id,
                        style: [styles.tab, active && styles.tabActive],
                        onPress: function () { setTab(t.id); }
                    }, h(RN.Text, { style: [styles.tabText, active && styles.tabTextActive], numberOfLines: 1 }, t.label));
                })
            ),
            body
        );
    }

    // ───────────────────────── Жизненный цикл ─────────────────────────

    var patches = [];

    function patchRows() {
        var RowManager = null;
        try { RowManager = metro.findByName("RowManager"); } catch (e) { }
        if (!RowManager || !RowManager.prototype || typeof RowManager.prototype.generate !== "function") {
            logger.log("MessageLogger: RowManager не найден, подсветка отключена");
            return;
        }
        patches.push(patcher.after("generate", RowManager.prototype, function (args, row) {
            try {
                if (!storage.highlight || !row) return;
                var data = args[0];
                if (!data || data.rowType !== 1) return;
                var id = (data.message && data.message.id) || (row.message && row.message.id);
                if (!id || !db.deleted[id] || !storage.keepInChat) return;
                row.backgroundHighlight = {
                    backgroundColor: RN.processColor(DELETED_COLOR + "26"),
                    gutterColor: RN.processColor(DELETED_COLOR + "ff")
                };
            } catch (e) { }
        }));
    }

    return {
        onLoad: function () {
            Object.keys(DEFAULTS).forEach(function (k) {
                if (storage[k] === undefined) storage[k] = DEFAULTS[k];
            });
            if (!FM) {
                logger.error("MessageLogger: нативный файловый модуль не найден — лог не будет сохраняться на диск");
                dbLoaded = true;
            } else {
                loadDb();
            }
            patches.push(patcher.before("dispatch", FluxDispatcher, onDispatch));
            patchRows();
        },
        onUnload: function () {
            patches.forEach(function (unpatch) { try { unpatch(); } catch (e) { } });
            patches = [];
            flushSave();
            rawCache.clear();
        },
        settings: Settings
    };
})()
