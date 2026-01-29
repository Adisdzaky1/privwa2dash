import makeWASocket, {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  proto,
  jidDecode,
  delay,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  getContentType,
  DisconnectReason,
  BufferJSON,
  initAuthCreds // TAMBAHKAN INI
} from '@whiskeysockets/baileys';
import { Redis } from '@upstash/redis';
import QRCode from 'qrcode';
import pino from 'pino';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Konfigurasi Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Fungsi untuk mendapatkan sesi dari Redis
// Fungsi untuk mendapatkan sesi dari Supabase
async function getSession(nomor) {
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('auth_state, updated_at')
      .eq('number', nomor)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error(`Error fetching session for ${nomor}:`, error.message);
      throw new Error(error.message);
    }

    // Cek apakah session sudah expired (30 hari)
    if (data && data.auth_state) {
      const updatedAt = new Date(data.updated_at);
      const now = new Date();
      const diffDays = (now - updatedAt) / (1000 * 60 * 60 * 24);
      
      if (diffDays > 30) {
        console.log(`Session for ${nomor} expired, deleting...`);
        await deleteSession(nomor);
        return null;
      }

      try {
        return JSON.parse(data.auth_state, BufferJSON.reviver); // Tambahkan reviver
      } catch (e) {
        console.error(`Error parsing auth state for ${nomor}:`, e.message);
        return null;
      }
    }
    return null;
  } catch (err) {
    console.error(`Error in getSession:`, err.message);
    return null;
  }
}

// Fungsi untuk menyimpan sesi ke Supabase
async function saveSession(nomor, state) {
  try {
    const { error } = await supabase
  .from('whatsapp_sessions')
  .upsert([{ 
    number: nomor, 
    auth_state: JSON.stringify(state, BufferJSON.replacer), // Tambahkan replacer
    updated_at: new Date().toISOString()
  }], { onConflict: 'number' });

    if (error) {
      console.error(`Error saving session for ${nomor}:`, error.message);
      throw new Error(error.message);
    }
  } catch (err) {
    console.error(`Error in saveSession:`, err.message);
  }
}

// Fungsi untuk mengunduh gambar dari URL
async function downloadImage(url) {
  try {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer'
    });
    
    return response.data;
  } catch (error) {
    console.error('Error downloading image:', error.message);
    throw error;
  }
}
/*
async function handleConnect(req, res, nomor) {
  if (!nomor) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "nomor" diperlukan untuk koneksi',
    });
  }

  const usePairingCode = true;

  try {
    const savedState = await getSession(nomor);
    const authState = {
      creds: savedState?.creds || initAuthCreds(),
      keys: makeCacheableSignalKeyStore(savedState?.keys || {}, pino({ level: "silent" }))
    };

    const sock = makeWASocket({
          logger: pino({ level: "silent" }),
          printQRInTerminal: false,
          auth: authState,
          browser: ["Ubuntu", "Chrome", "20.0.04"], // Gunakan browser yang lebih stabil
        });

    sock.ev.on('connection.update', async (update) => {
      try {
        const { qr, connection, lastDisconnect, pairingCode } = update;

        if (qr) {
          const qrImage = await QRCode.toDataURL(qr);
          if (!res.headersSent) {
            return res.status(200).json({
              status: 'success',
              qrCode: qrImage,
              message: `QR code for ${nomor} generated successfully`,
            });
          }
          return;
        }

        if (pairingCode) {
          if (!res.headersSent) {
            return res.status(200).json({
              status: 'success',
              pairingCode,
              message: `Pairing code for ${nomor} generated successfully`,
            });
          }
          return;
        }

        if (connection === 'open') {
          console.log(`Connected to WhatsApp for nomor: ${nomor}`);
          await redis.set(`whatsapp:connected:${nomor}`, 'true', { ex: 86400 });
          
          // Simpan informasi user
          if (sock?.user) {
            await redis.set(`whatsapp:user:${nomor}`, JSON.stringify(sock.user), { ex: 86400 });
          }
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
          console.log(`Connection closed for nomor: ${nomor} - Reason: ${reason}`);
          
          await redis.del(`whatsapp:connected:${nomor}`);
          await redis.del(`whatsapp:user:${nomor}`);

          if (reason === DisconnectReason.loggedOut) {
            console.log('User logged out, clearing session');
            await redis.del(`whatsapp:session:${nomor}`);
            await redis.srem('whatsapp:sessions:list', nomor);
          }
        }
      } catch (error) {
        console.error('Error in connection.update handler:', error.message);
      }
    });

    sock.ev.on('creds.update', async (newState) => {
      try {
        const stateToSave = {
          creds: newState,
          keys: sock.authState.keys
        };
        await saveSession(nomor, stateToSave);
      } catch (err) {
        console.error(`Failed to save session for ${nomor}:`, err.message);
      }
    });

    if (usePairingCode && sock.requestPairingCode) {
      try {
        const code = await sock.requestPairingCode(nomor);
        console.log(`Pairing code for ${nomor}: ${code}`);
        if (!res.headersSent) {
          return res.status(200).json({
            status: 'success',
            pairingCode: code,
            message: `Pairing code for ${nomor} generated successfully`,
          });
        }
      } catch (error) {
        console.error('Error getting pairing code:', error.message);
        if (!res.headersSent) {
          return res.status(500).json({
            status: 'error',
            message: 'Failed to get pairing code'
          });
        }
      }
    }

    // Jika tidak ada QR atau pairing code, return status
    setTimeout(() => {
      if (!res.headersSent) {
        return res.status(200).json({
          status: 'waiting',
          message: 'Waiting for QR code or pairing code...'
        });
      }
    }, 30000);

  } catch (error) {
    console.error(`Error during WhatsApp connection:`, error.message);
    if (!res.headersSent) {
      return res.status(500).json({
        status: 'error',
        message: 'Failed to connect to WhatsApp',
      });
    }
  }
}

*/

// Fungsi untuk handle status koneksi
async function handleStatus(res, nomor) {
  if (!nomor) {
    return res.status(400).json({
      status: 'error',
      message: 'Parameter "nomor" diperlukan'
    });
  }

  try {
    const sessionExists = await redis.exists(`whatsapp:session:${nomor}`);
    const isConnected = await redis.exists(`whatsapp:connected:${nomor}`);
    const userInfo = await redis.get(`whatsapp:user:${nomor}`);
    
    const ttl = await redis.ttl(`whatsapp:session:${nomor}`);
    
    return res.status(200).json({
      status: 'success',
      data: {
        nomor,
        has_session: sessionExists === 1,
        is_connected: isConnected === 1,
        session_expires_in: ttl > 0 ? `${Math.floor(ttl / 86400)} hari` : 'tidak ada expiry',
        user_info: userInfo ? JSON.parse(userInfo) : null
      }
    });
  } catch (error) {
    console.error('Error checking status:', error.message);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to check status'
    });
  }
}

// Fungsi utama untuk mengirim pesan
// ... (Bagian import tetap sama)

// Tambahkan helper untuk memproses data kunci (keys) agar kompatibel dengan Baileys
const initSignalKeyStore = (keys) => {
  return {
    get: (type, ids) => {
      const classType = type;
      return ids.reduce((dict, id) => {
        const value = keys[classType]?.[id];
        if (value) dict[id] = value;
        return dict;
      }, {});
    },
    set: (data) => {
      for (const type in data) {
        if (!keys[type]) keys[type] = {};
        Object.assign(keys[type], data[type]);
      }
    }
  };
};

async function handleSendMessage(res, params) {
  const { message, nomor, image_url, tujuan } = params;

  if (!tujuan) {
    return res.status(400).json({ status: 'error', message: 'Nomor tujuan wajib diisi' });
  }

  try {
    const savedState = await getSession(nomor);
    if (!savedState) {
      return res.status(400).json({
        status: 'error',
        message: 'Sesi tidak ditemukan. Silakan pairing ulang.',
      });
    }

    // PERBAIKAN: Inisialisasi keys agar memiliki fungsi .get() dan .set()
    const myKeys = savedState.keys || {};
    const authState = {
      creds: savedState.creds,
      keys: makeCacheableSignalKeyStore(initSignalKeyStore(myKeys), pino({ level: "silent" }))
    };

    const sock = makeWASocket({
      logger: pino({ level: "error" }),
      auth: authState,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      markOnlineOnConnect: false,
    });

    const formattednomor = `${tujuan.replace(/\D/g, '')}@s.whatsapp.net`;

    // PERBAIKAN: Gunakan Promise agar proses pengiriman ditunggu sampai selesai
    return new Promise((resolve) => {
      let isDone = false;

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          try {
            await sleep(3000); // Jeda agar koneksi stabil

            if (image_url && image_url !== 'false') {
              const imageBuffer = await downloadImage(image_url);
              await sock.sendMessage(formattednomor, {
                image: imageBuffer,
                caption: message
              });
            } else {
              await sock.sendMessage(formattednomor, { text: message });
            }

            if (!res.headersSent) {
              res.status(200).json({ status: 'success', message: 'Pesan terkirim' });
            }
            isDone = true;
            sock.ws.close();
            resolve();
          } catch (err) {
            console.error('Kirim Gagal:', err.message);
            if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
            sock.ws.close();
            resolve();
          }
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            await supabase.from('whatsapp_sessions').delete().eq('number', nomor);
          }
          resolve();
        }
      });

      sock.ev.on('creds.update', async () => {
        // PERBAIKAN: Simpan kembali ke DB setiap kali ada update keys
        await saveSession(nomor, {
          creds: sock.authState.creds,
          keys: myKeys // myKeys sudah terupdate otomatis via referensi di initSignalKeyStore
        });
      });

      // Timeout 25 detik
      setTimeout(() => {
        if (!isDone && !res.headersSent) {
          res.status(408).json({ status: 'error', message: 'Request Timeout' });
          sock.ws.close();
          resolve();
        }
      }, 25000);
    });

  } catch (error) {
    if (!res.headersSent) res.status(500).json({ status: 'error', message: error.message });
  }
}

export default async (req, res) => {
  try {
    const { nomor, image_url, message, tujuan, action = 'send' } = req.query;

    switch (action) {
      case 'status':
        return handleStatus(res, nomor);
      case 'send':
        if (!nomor || !tujuan) {
          return res.status(400).json({ status: 'error', message: 'Nomor pengirim dan tujuan wajib ada' });
        }
        return handleSendMessage(res, { message, nomor, image_url, tujuan });
      default:
        return res.status(400).json({ status: 'error', message: 'Action tidak valid' });
    }
  } catch (error) {
    return res.status(500).json({ status: 'error', message: error.message });
  }
};
