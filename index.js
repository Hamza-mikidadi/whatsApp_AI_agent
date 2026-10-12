const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');

const startTime = Math.floor(Date.now() / 1000);

// ====== RÉGLAGES ======
const HISTORY_LIMIT = 40;        // nombre de messages relus à chaque fois
const DEBOUNCE_MS = 2000;        // attend que la personne ait fini d'envoyer ses messages
const MIN_DELAY_MS = 2000;       // délai minimum avant de répondre
const MAX_DELAY_MS = 120000;     // délai maximum (2 minutes)
const DEFAULT_DELAY_MS = 6000;   // si pas assez d'historique pour calculer le rythme
const MAX_GAP_SECONDS = 3600;    // un silence > 1h n'est pas compté dans le rythme

// Liste des numéros autorisés
const ALLOWED_RAW_NUMBERS = [
    '919805145927@c.us',
    '235133051388125@lid',
    '2693987981@c.us',
    '2694876072@c.us',
    '84156327456790@c.us',
    '919462115431@c.us',
    '919622586309@c.us'
];
const ALLOWED_DIGITS = ALLOWED_RAW_NUMBERS.map(n => n.split('@')[0]);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('\n--- SCANNE CE QR CODE AVEC TON WHATSAPP ---\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n✅ Ton assistant WhatsApp est connecté et écoute uniquement les numéros autorisés !');
});

// ----- Historique local (sauvegardé dans history.json) -----
const HISTORY_FILE = 'history.json';
let localHistory = {};
try { localHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8')); } catch (e) {}

function recordLocal(number, fromMe, body, timestamp) {
    const arr = localHistory[number] || (localHistory[number] = []);
    arr.push({ fromMe, body, timestamp: timestamp || Math.floor(Date.now() / 1000) });
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(localHistory)); } catch (e) {}
}

// Empêche une étape WhatsApp de bloquer indéfiniment
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} trop long (>${ms / 1000}s)`)), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

// Découpe la réponse en plusieurs messages (séparés par une ligne vide)
function splitText(text, max = 3500) {
    const parts = [];
    for (const block of text.split(/\n\s*\n/)) {
        const b = block.trim();
        if (!b) continue;
        for (let i = 0; i < b.length; i += max) parts.push(b.slice(i, i + max));
    }
    return parts;
}

// Récupère tous les identifiants possibles de l'expéditeur
async function getSenderCandidates(msg) {
    const candidates = new Set();
    candidates.add(msg.from.split('@')[0]);
    try {
        const contact = await withTimeout(msg.getContact(), 5000, 'getContact');
        if (contact) {
            if (contact.number) candidates.add(String(contact.number));
            if (contact.id && contact.id.user) candidates.add(String(contact.id.user));
        }
    } catch (err) {}
    if (msg.from.endsWith('@lid')) {
        try {
            const res = await withTimeout(client.getContactLidAndPhone([msg.from]), 5000, 'getContactLidAndPhone');
            if (res && res[0] && res[0].pn) candidates.add(res[0].pn.split('@')[0]);
        } catch (err) {}
    }
    return [...candidates];
}

// Rythme de la personne : temps médian qu'elle met pour répondre (en secondes)
function computeRhythm(history) {
    const gaps = [];
    for (let i = 1; i < history.length; i++) {
        const prev = history[i - 1];
        const cur = history[i];
        // moi -> eux : combien de temps ils mettent à répondre
        if (prev.fromMe && !cur.fromMe) {
            const gap = cur.timestamp - prev.timestamp;
            if (gap >= 0 && gap <= MAX_GAP_SECONDS) gaps.push(gap);
        }
    }
    if (gaps.length < 2) return null;
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

async function handleConversation(msgs, senderNumber, arrivedAt) {
    const lastMsg = msgs[msgs.length - 1];
    const combined = msgs.map((m) => m.body).join('\n');

    // ---------- 0) Relire toute la conversation ----------
    let chat = null;
    let contactName = '';
    let history = [];
    try {
        const contact = await withTimeout(lastMsg.getContact(), 5000, 'getContact');
        contactName = (contact && (contact.name || contact.pushname)) || '';
    } catch (err) {}
    try {
        chat = await withTimeout(lastMsg.getChat(), 5000, 'getChat');
        if (!contactName) contactName = chat.name || '';
        const fetched = await withTimeout(chat.fetchMessages({ limit: HISTORY_LIMIT }), 8000, 'fetchMessages');
        history = fetched
            .filter((m) => m.type === 'chat' && m.body && m.body.trim() !== '')
            .map((m) => ({ fromMe: !!m.fromMe, body: m.body, timestamp: m.timestamp }));
    } catch (err) {
        console.log(`ℹ️ Historique WhatsApp indisponible (${err.message}), j'utilise l'historique local.`);
    }
    if (history.length < 2) {
        history = (localHistory[senderNumber] || []).slice(-HISTORY_LIMIT);
    }

    console.log(`[1/4] Historique : ${history.length} messages`);

    // ---------- 1) Calcul du rythme ----------
    const rhythmSec = computeRhythm(history);
    let targetDelay = rhythmSec !== null ? rhythmSec * 1000 : DEFAULT_DELAY_MS;
    targetDelay = clamp(targetDelay * (0.8 + Math.random() * 0.4), MIN_DELAY_MS, MAX_DELAY_MS);
    console.log(
        rhythmSec !== null
            ? `[RYTHME] La personne répond en ~${Math.round(rhythmSec)}s → je vise ~${Math.round(targetDelay / 1000)}s`
            : `[RYTHME] Pas assez d'historique → délai par défaut ~${Math.round(targetDelay / 1000)}s`
    );

    // ---------- 2) Appel à Flask ----------
    console.log('[2/4] Appel à Flask...');
    let replyText;
    const tFlask = Date.now();
    try {
        const response = await axios.post(
            'http://127.0.0.1:5000/process-message',
            { sender: senderNumber, message: combined, history, contact_name: contactName },
            { headers: { 'Content-Type': 'application/json' }, timeout: 45000 }
        );
        replyText = response.data.reply;
        console.log(`[TIMING] Flask a répondu en ${((Date.now() - tFlask) / 1000).toFixed(1)}s`);
    } catch (error) {
        const errDetail = error.response
            ? `Statut ${error.response.status} - ${JSON.stringify(error.response.data)}`
            : error.message;
        console.error('❌ Erreur Flask :', errDetail);
        return;
    }
    if (!replyText) return;

    // ---------- 3) Envoi façon humaine, au rythme de la personne ----------
    console.log('[3/4] Envoi en cours...');
    try {
        const parts = splitText(replyText);

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];

            // 1er message : on attend ce qui reste du délai visé (compté depuis la réception)
            // Messages suivants : petit écart naturel
            const remaining = i === 0
                ? Math.max(0, targetDelay - (Date.now() - arrivedAt))
                : 800 + Math.random() * 1200;

            const typingTime = Math.min(clamp(600 + part.length * 45, 800, 8000), remaining);

            await sleep(remaining - typingTime);
            if (typingTime > 0) {
                try { if (chat) await withTimeout(chat.sendStateTyping(), 3000, 'typing'); } catch (e) {}
                await sleep(typingTime);
            }

            await withTimeout(client.sendMessage(lastMsg.from, part, { sendSeen: false }), 20000, 'sendMessage');
            recordLocal(senderNumber, true, part);

            if (i === 0) {
                console.log(`[TIMING] reçu → envoyé : ${((Date.now() - arrivedAt) / 1000).toFixed(1)}s (visé ${(targetDelay / 1000).toFixed(1)}s)`);
            }
        }
        try { if (chat) await withTimeout(chat.clearState(), 3000, 'clearState'); } catch (e) {}
        console.log(`[4/4] ✅ RÉPONSE ENVOYÉE : ${replyText}`);
    } catch (error) {
        console.error("❌ Erreur d'envoi WhatsApp :", error);
    }
}

// ----- Regroupement des messages rapprochés + file d'attente par personne -----
const pending = new Map(); // from -> { msgs, timer, senderNumber }
const chains = new Map();  // from -> Promise (une seule réponse à la fois par personne)

client.on('message', async (msg) => {
    if (msg.timestamp < startTime) return;
    if (msg.from.includes('broadcast') || msg.fromMe) return;
    if (msg.from.endsWith('@g.us')) return;
    if (!msg.body || msg.body.trim() === '') return;

    const candidates = await getSenderCandidates(msg);
    const matched = candidates.find((c) => ALLOWED_DIGITS.includes(c));

    if (!matched) {
        console.log(`[IGNORÉ] Message de ${msg.from} (identifiants testés : ${candidates.join(', ')})`);
        return;
    }

    const senderNumber = `${matched}@c.us`;
    console.log(`[MESSAGE AUTORISÉ] De ${senderNumber} : ${msg.body}`);
    recordLocal(senderNumber, false, msg.body, msg.timestamp);

    const entry = pending.get(msg.from) || { msgs: [], timer: null, senderNumber };
    entry.msgs.push(msg);
    entry.arrivedAt = Date.now();
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
        pending.delete(msg.from);
        const prev = chains.get(msg.from) || Promise.resolve();
        const next = prev
            .then(() => withTimeout(handleConversation(entry.msgs, entry.senderNumber, entry.arrivedAt), 240000, 'conversation'))
            .catch((e) => console.error('❌ Erreur inattendue :', e));
        chains.set(msg.from, next);
    }, DEBOUNCE_MS);
    pending.set(msg.from, entry);
});

client.initialize();