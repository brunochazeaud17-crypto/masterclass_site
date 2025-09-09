/*
 * A simple Node.js HTTP server for the masterclass site. This server is
 * self‑contained and does not rely on external dependencies such as Express.
 * It serves static files from the `public` directory, processes form
 * submissions from the registration page, persists registrations to disk
 * and schedules emails relative to the selected session. The email sending
 * functionality is a stub; integrate your own provider if you wish to
 * deliver real messages.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');
const nodemailer = require('nodemailer');

// Helper to derive the public base URL behind a proxy (Render/Railway)
function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Les APIs Google Sheets ne sont plus utilisées. Nous n’importons plus googleapis.
// const { google } = require('googleapis');
// Airtable integration for storing registrations
const Airtable = require('airtable');

// Charger les variables d’environnement depuis le fichier .env, s’il existe
try {
  require('dotenv').config();
} catch (e) {
  // dotenv est facultatif ; si non présent, continue silencieusement
}

// ===== Tracking storage (simple JSON file) =====
const VIEWS_FILE = path.join(__dirname, 'views.json');
function readViews() {
  try { return JSON.parse(fs.readFileSync(VIEWS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeViews(obj) {
  fs.writeFileSync(VIEWS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}
function readJSON(req) {
  return new Promise((resolve) => {
    let data='';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
  });
}
// ==============================================

// Les intégrations Google Sheets ont été retirées. Si vous souhaitez
// utiliser Google Sheets, réintroduisez les variables et la logique
// correspondantes. Les variables sont définies comme undefined pour
// désactiver l’intégration.
const SHEET_ID = undefined;
const GOOGLE_CLIENT_EMAIL = undefined;
const GOOGLE_PRIVATE_KEY = undefined;

let sheetsApi = null;

// Airtable configuration
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Registrations';
let airtableBase = null;
if (AIRTABLE_API_KEY && AIRTABLE_BASE_ID) {
  Airtable.configure({ apiKey: AIRTABLE_API_KEY });
  airtableBase = Airtable.base(AIRTABLE_BASE_ID);
}

/**
 * Appends a row to the configured Google Sheet. Requires that the
 * environment variables SHEET_ID, GOOGLE_CLIENT_EMAIL et GOOGLE_PRIVATE_KEY
 * soient définies. Si ces variables ne sont pas présentes, la fonction
 * renvoie simplement sans rien faire. La première ligne de la feuille doit
 * contenir les en‑têtes (Prénom, Nom, Email) pour un affichage correct.
 * @param {Array<string>} row Le tableau de valeurs à ajouter (prénom, nom, email)
 */
async function appendToSheet(row) {
  if (!SHEET_ID || !GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    // Credentials not configured
    console.warn('Google Sheets credentials are not fully configured. Skipping spreadsheet update.');
    return;
  }
  // Initialiser l’API une seule fois
  if (!sheetsApi) {
    const jwt = new google.auth.JWT(
      GOOGLE_CLIENT_EMAIL,
      null,
      GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );
    sheetsApi = google.sheets({ version: 'v4', auth: jwt });
  }
  try {
    await sheetsApi.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A:C',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('Nouvelle inscription ajoutée au Google Sheet');
  } catch (err) {
    console.error('Erreur lors de l’ajout au Google Sheet :', err.message);
  }
}

/**
 * Append a registration to Airtable. Requires AIRTABLE_API_KEY and
 * AIRTABLE_BASE_ID environment variables. The table name can be
 * configured via AIRTABLE_TABLE_NAME (default: "Registrations").
 * Each record includes les champs "Prénom", "Nom", "Email" et "Session".
 *
 * @param {Array<string>} row Tableau [prenom, nom, email, sessionISO]
 * @returns {Promise<void>}
 */
function appendToAirtable(row) {
  return new Promise((resolve) => {
    if (!airtableBase) {
      console.warn('Airtable credentials are not fully configured. Skipping Airtable update.');
      return resolve();
    }
    const [prenom, nom, email, sessionISO] = row;
    airtableBase(AIRTABLE_TABLE_NAME).create(
      {
        "Prénom": prenom,
        "Nom": nom,
        "Email": email,
        "Session": sessionISO
      },
      (err, record) => {
        if (err) {
          console.error('Erreur lors de l’ajout dans Airtable :', err.message);
          return resolve();
        }
        console.log('Nouvelle inscription ajoutée à Airtable :', record.getId());
        resolve();
      }
    );
  });
}

// File to store registrations
const REG_FILE = path.join(__dirname, 'registrations.json');
// Ensure the registration file exists
if (!fs.existsSync(REG_FILE)) {
  fs.writeFileSync(REG_FILE, '[]', 'utf8');
}

// Write an email to a log file. This stub simulates sending an email by
// appending it to emails.log. Replace this with your actual email
// integration (e.g. nodemailer) if desired.
// Configure the nodemailer transporter. To use your Gmail account, set
// the environment variables GMAIL_USER and GMAIL_PASS with your Gmail
// address and either your password or an app password (recommended for
// security). See Google’s documentation on how to create an app
// password for Gmail.
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER || 'contact.lmerel@gmail.com',
    // Supprimer tous les espaces du mot de passe d’application fourni pour Gmail.
    pass: (process.env.GMAIL_PASS || '').replace(/\s+/g, '')
  }
});

/**
 * Envoyer un email en HTML. Les erreurs sont consignées dans emails.log. En
 * parallèle, chaque envoi est consigné dans ce fichier pour référence.
 *
 * @param {string} to   Destinataire
 * @param {string} subject Sujet de l’email
 * @param {string} html Corps de l’email au format HTML
 */
function sendEmail(to, subject, html) {
  const mailOptions = {
    from: `Laurence Merel <${process.env.GMAIL_USER || 'contact.lmerel@gmail.com'}>`,
    to,
    subject,
    html
  };
  transporter.sendMail(mailOptions, (error, info) => {
    const logEntry = `---\nDate: ${new Date().toISOString()}\nTo: ${to}\nSubject: ${subject}\n`;    
    if (error) {
      fs.appendFileSync(path.join(__dirname, 'emails.log'), logEntry + `ERROR: ${error.message}\n\n`);
      console.error('Erreur envoi email:', error);
    } else {
      fs.appendFileSync(path.join(__dirname, 'emails.log'), logEntry + `Message sent: ${info.response}\n\n`);
      console.log(`Email envoyé à ${to}: ${subject}`);
    }
  });
}

// Schedule an email relative to an event date/time
function scheduleEmail(eventDate, offsetMs, to, subject, html) {
  const sendTime = new Date(eventDate.getTime() + offsetMs);
  const delay = sendTime.getTime() - Date.now();
  const schedule = () => sendEmail(to, subject, html);
  if (delay <= 0) {
    // If the scheduled time is already passed, send immediately
    schedule();
  } else {
    setTimeout(schedule, delay);
  }
}

// Format a date to a French friendly string in Europe/Paris timezone
function formatDate(date) {
  return date.toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Determine content type based on file extension
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.mp4': return 'video/mp4';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}

// Serve a static file from the public directory
function serveStatic(filePath, res) {
  const fullPath = path.join(__dirname, 'public', filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.statusCode = 404;
      res.end('Fichier non trouvé');
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', getContentType(fullPath));
    res.end(data);
  });
}

// Create the HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // Handle registration form submission
  if (req.method === 'POST' && pathname === '/register') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const data = querystring.parse(body);
      const firstName = data.firstName || '';
      const lastName = data.lastName || '';
      const email = data.email || '';
      const session = data.session || '';
      const consent = data.consent;
      if (!firstName || !email || !session || !consent) {
        res.statusCode = 400;
        res.end('Merci de remplir tous les champs requis et d’accepter la politique d’e‑mail.');
        return;
      }
      const eventDate = new Date(session);
      // Persist registration
      let registrations;
      try {
        registrations = JSON.parse(fs.readFileSync(REG_FILE, 'utf8'));
      } catch (e) {
        registrations = [];
      }
      registrations.push({ firstName, lastName, email, session: eventDate.toISOString() });
      fs.writeFileSync(REG_FILE, JSON.stringify(registrations, null, 2));

      // L’intégration avec Google Sheet a été désactivée, nous n’ajoutons plus
      // les nouvelles inscriptions au tableur Google.
      // Ajouter la nouvelle inscription dans Airtable (Prénom, Nom, Email, Session)
      appendToAirtable([firstName, lastName, email, eventDate.toISOString()]).catch(err => {
        // Les erreurs sont déjà loggées dans appendToAirtable
      });
      // Préparer le lien de connexion unique en fonction de la session choisie
      // Base URL priority: APP_BASE_URL > BASE_URL > headers from proxy (Render provides these)
const baseUrl =
  process.env.APP_BASE_URL ||
  process.env.BASE_URL ||
  getBaseUrl(req);

// Build the URL safely
const url = new URL('/masterclass.html', baseUrl);
url.searchParams.set('session', eventDate.toISOString());
const joinLink = url.toString();

      // Construire le titre de webinar
      const webinarTitle = 'Accueillir l’Âme de ton enfant';
      // Contenus HTML pour chaque mail avec les emojis pour un ton chaleureux
      const confirmationSubject = `✨ Ton voyage commence — Masterclass ${webinarTitle}`;
      const confirmationHtml = `\
        <p>Bonjour ${firstName},</p>
        <p>🌸 Ton rendez‑vous est confirmé&nbsp;!</p>
        <p>Tu viens d’ouvrir une porte. Une porte vers un espace sacré, un moment hors du temps… Ce sera un instant précieux où nous explorerons ensemble 3 clefs essentielles pour aller à la rencontre de ton enfant et mieux le comprendre.</p>
        <p>Tu pourras te connecter à la Masterclass via ce lien&nbsp;:<br/><a href="${joinLink}">${joinLink}</a></p>
        <p>Je t’invite à créer, chez toi, un petit cocon pour ce moment&nbsp;: une bougie, un carnet, un espace calme, et l’envie de plonger dans cette connexion intime entre toi et ton enfant.</p>
        <p>Avec toute ma douceur,</p>
        <p>Laurence<br/>Médium‑thérapeute, accompagnatrice des parents et futurs parents</p>
      `;
      const dayBeforeSubject = `✨ C’est demain — ta Masterclass`;
      const dayBeforeHtml = `\
        <p>Coucou ${firstName},</p>
        <p>Demain (${formatDate(eventDate)}) nous partagerons un moment sacré pour accueillir l’Âme de ton enfant. Prépare un endroit calme et de quoi prendre des notes.</p>
        <p>Lien d’accès&nbsp;: <a href="${joinLink}">${joinLink}</a></p>
        <p>À très vite,<br/>Laurence</p>
      `;
      // Rappel 5 heures avant
      const fiveHoursSubject = `✨ C’est aujourd’hui — ta Masterclass`;
      const fiveHoursHtml = `\
        <p>Coucou ${firstName},</p>
        <p>Le moment est arrivé… aujourd’hui, nous allons nous retrouver pour un temps sacré, un espace hors du quotidien, afin d’explorer ensemble les 3 clefs majeures pour accueillir l’Âme de ton enfant.</p>
        <p>Tu pourras te connecter ici&nbsp;: <a href="${joinLink}">${joinLink}</a></p>
        <p>Prépare un petit cocon&nbsp;: un coin tranquille, peut-être une bougie, un plaid, un carnet… et surtout ta pleine attention.</p>
        <p>🌸 Dans quelques heures, nous franchirons ensemble ce portail.</p>
        <p>Avec toute ma douceur,<br/>Laurence</p>
      `;
      const oneHourSubject = `⏳ Dans 1 heure, nous ouvrons ensemble ce Portail vers l’Âme`;
      const oneHourHtml = `\
        <p>Coucou ${firstName},</p>
        <p>Nous nous retrouvons dans moins d’une heure&nbsp;! Profite de ce moment pour ralentir, écouter et ressentir ta flamme intérieure. C’est elle qui te permettra de t’ouvrir à l’Âme de ton enfant 😊</p>
        <p>📍 Lien d’accès&nbsp;: <a href="${joinLink}">${joinLink}</a></p>
        <p>Je me réjouis de t’offrir ce cadeau,<br/>À tout à l’heure,<br/>Laurence</p>
      `;
      const halfHourSubject = `🔔 Dans 30 minutes, nous commençons notre voyage sacré`;
      const halfHourHtml = `\
        <p>Coucou ${firstName}&nbsp;!</p>
        <p>Nous y sommes presque… Un temps pour toi, que tu sois sur le chemin de la parentalité ou déjà parent, tu vas pouvoir te reconnecter à l’essence de ce lien sacré.</p>
        <p>📍 Lien d’accès&nbsp;: <a href="${joinLink}">${joinLink}</a></p>
        <p>🌸 Ce moment est pour toi… et pour lui.<br/>À tout à l’heure,<br/>Avec toute ma douceur,<br/>Laurence</p>
      `;
      const afterSubject = `💖 Merci… et un pas de plus vers toi et ton enfant`;
      const afterHtml = `\
        <p>Bonjour ${firstName},</p>
        <p>Merci d’avoir partagé ce moment avec moi lors de la Masterclass “Accueillir l’Âme de ton enfant”. J’espère que ces instants t’ont offert douceur, clarté et peut-être même quelques prises de conscience profondes.</p>
        <p>Que tu sois en chemin vers la parentalité ou déjà parent, je souhaite que ces 3 clefs t’accompagnent&nbsp;:</p>
        <ul>
          <li>Cultiver un lien d’âme à âme avec ton enfant, qu’il soit à naître ou déjà là</li>
          <li>Apaiser tes peurs et nourrir ta confiance</li>
          <li>Créer un environnement d’amour et de sérénité autour de lui… et autour de toi</li>
        </ul>
        <p>🌸 Ce voyage ne fait que commencer.</p>
        <p>Si tu ressens l’élan de poursuivre, je t’offre un appel découverte de 30&nbsp;minutes, entièrement gratuit, pour échanger sur ta situation, tes besoins et voir comment je peux t’accompagner plus en profondeur.</p>
        <p>📅 Réserve ton créneau ici&nbsp;: <a href="https://calendly.com/laurmerel/30min">https://calendly.com/laurmerel/30min</a></p>
        <p>Je serai heureuse de t’entendre, de répondre à tes questions et, peut-être, de marcher à tes côtés dans ce chapitre si précieux de ta vie.</p>
        <p>Avec toute ma douceur et ma gratitude,<br/>Laurence<br/>Médium‑thérapeute, accompagnatrice des parents et futurs parents</p>
      `;
      // Envoyer le mail de confirmation à la personne inscrite
      sendEmail(email, confirmationSubject, confirmationHtml);
      // Programmer les rappels : J-1 (24h), Jour J (-5h), -1h, -30min et +1h
      scheduleEmail(eventDate, -24 * 60 * 60 * 1000, email, dayBeforeSubject, dayBeforeHtml);
      scheduleEmail(eventDate, -5 * 60 * 60 * 1000, email, fiveHoursSubject, fiveHoursHtml);
      scheduleEmail(eventDate, -1 * 60 * 60 * 1000, email, oneHourSubject, oneHourHtml);
      scheduleEmail(eventDate, -0.5 * 60 * 60 * 1000, email, halfHourSubject, halfHourHtml);
      scheduleEmail(eventDate, 1 * 60 * 60 * 1000, email, afterSubject, afterHtml);
      // Notifier les organisateurs de la nouvelle inscription (nom, prénom, créneau)
      const adminSubject = `Nouvelle inscription à la masterclass`;
      let sheetLinkHtml = '';
      // Lien vers la feuille Google Sheet supprimé car l’intégration est désactivée
      let airtableLinkHtml = '';
      if (AIRTABLE_BASE_ID) {
        const linkAt = `https://airtable.com/${AIRTABLE_BASE_ID}`;
        airtableLinkHtml = `<p>Base Airtable des inscriptions&nbsp;: <a href="${linkAt}">${linkAt}</a></p>`;
      }
      const adminHtml = `\
        <p>Une nouvelle personne s'est inscrite à la masterclass.</p>
        <p><strong>Prénom&nbsp;:</strong> ${firstName}<br/>
        <strong>Nom&nbsp;:</strong> ${lastName}<br/>
        <strong>Email&nbsp;:</strong> ${email}<br/>
        <strong>Créneau choisi&nbsp;:</strong> ${formatDate(eventDate)}</p>
        ${sheetLinkHtml}
        ${airtableLinkHtml}
      `;
      sendEmail('bruno.chazreaud@gmail.com, laurmerel@gmail.com', adminSubject, adminHtml);
      // Redirect to confirmation page with query parameters
      res.statusCode = 302;
      res.setHeader('Location', `/confirm.html?name=${encodeURIComponent(firstName)}&date=${encodeURIComponent(eventDate.toISOString())}`);
      res.end();
    });
    return;

  // Tracking endpoints
  if (req.method === 'POST' && (pathname === '/track' || pathname === '/track-complete')) {
    const body = await readJSON(req);
    const token = String((body.token||'')).trim();
    const db = readViews();
    const cur = db[token] || { watched: 0, completed: false, lastPing: null };
    if (pathname === '/track') {
      const watched = Number(body.watchedSeconds || 0) | 0;
      if (token) {
        cur.watched = Math.max(cur.watched, watched);
        cur.lastPing = new Date().toISOString();
        db[token] = cur;
        writeViews(db);
      }
      res.writeHead(204); return res.end();
    } else {
      if (token) {
        cur.completed = true;
        cur.lastPing = new Date().toISOString();
        db[token] = cur;
        writeViews(db);
      }
      res.writeHead(204); return res.end();
    }
  }
  if (req.method === 'GET' && pathname === '/admin/views') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(readViews(), null, 2));
  }
  }
  // Handle static GET requests
  if (req.method === 'GET') {
    // Normalise pathname to remove leading slash
    let filePath;
    if (pathname === '/' || pathname === '') {
      filePath = 'index.html';
    } else if (pathname.startsWith('/')) {
      filePath = pathname.slice(1);
    } else {
      filePath = pathname;
    }
    serveStatic(filePath, res);
    return;
  }
  // Fallback
  res.statusCode = 404;
  res.end('Page non trouvée');
});

// Start the server
let PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Masterclass app running. Port: ${PORT}`);
});
