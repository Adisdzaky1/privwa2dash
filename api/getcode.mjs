import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  Browsers,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  jidDecode,
  delay,
  getAggregateVotesInPollMessage,
  downloadContentFromMessage,
  getContentType,
  BufferJSON,
  initAuthCreds // TAMBAHKAN INI
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { createClient } from '@supabase/supabase-js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Konfigurasi Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// Fungsi untuk menghapus sesi
async function deleteSession(nomor) {
  try {
    const { error } = await supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('number', nomor);

    if (error) {
      console.error(`Error deleting session for ${nomor}:`, error.message);
      throw new Error(error.message);
    }
  } catch (err) {
    console.error(`Error in deleteSession:`, err.message);
  }
}

// Fungsi untuk mendapatkan semua sesi aktif
async function getAllSessions() {
  try {
    // Hanya ambil session yang masih valid (kurang dari 30 hari)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('number, updated_at')
      .gte('updated_at', thirtyDaysAgo.toISOString());

    if (error) {
      console.error(`Error fetching all sessions:`, error.message);
      throw new Error(error.message);
    }

    return data.map(item => item.number);
  } catch (err) {
    console.error(`Error in getAllSessions:`, err.message);
    return [];
  }
}

// Fungsi untuk mendapatkan info sesi
async function getSessionInfo(nomor) {
  try {
    const { data, error } = await supabase
      .from('whatsapp_sessions')
      .select('updated_at')
      .eq('number', nomor)
      .single();

    if (error) {
      return {
        exists: false,
        ttl: -2,
        expires_in: 'session not found'
      };
    }

    if (!data) {
      return {
        exists: false,
        ttl: -2,
        expires_in: 'session not found'
      };
    }

    const updatedAt = new Date(data.updated_at);
    const now = new Date();
    const diffMs = now - updatedAt;
    const diffDays = 30 - (diffMs / (1000 * 60 * 60 * 24));
    const ttl = Math.floor(diffDays * 86400); // Konversi ke detik

    let expiresIn = 'expired';
    if (diffDays > 0) {
      const days = Math.floor(diffDays);
      const hours = Math.floor((diffDays - days) * 24);
      expiresIn = `${days} hari ${hours} jam`;
    }

    return {
      exists: true,
      ttl: ttl > 0 ? ttl : 0,
      expires_in: expiresIn,
      updated_at: updatedAt.toISOString()
    };
  } catch (err) {
    console.error(`Error in getSessionInfo:`, err.message);
    return null;
  }
}

export default async (req, res) => {
  try {
    const nomor = req.query.nomor;
    const action = req.query.action || 'connect'; // connect, list, info, delete
    
    if (!nomor && !['list'].includes(action)) {
      return res.status(400).json({
        status: 'error',
        message: 'Parameter "nomor" is required for this action',
      });
    }
    
    // Handle different actions
    switch (action) {
      case 'list':
        const sessions = await getAllSessions();
        const sessionsInfo = [];
        
        for (const sessionNomor of sessions) {
          const info = await getSessionInfo(sessionNomor);
          sessionsInfo.push({
            nomor: sessionNomor,
            ...info
          });
        }
        
        return res.status(200).json({
          status: 'success',
          total_sessions: sessions.length,
          sessions: sessionsInfo
        });
        
      case 'info':
        const info = await getSessionInfo(nomor);
        return res.status(200).json({
          status: 'success',
          nomor: nomor,
          ...info
        });
        
      case 'delete':
        await deleteSession(nomor);
        return res.status(200).json({
          status: 'success',
          message: `Session for ${nomor} deleted successfully`
        });
    }
    
    // Fungsi untuk koneksi ke WhatsApp (action = 'connect')
    async function connectToWhatsApp() {
      try {
        // Ambil session dari Supabase
        const savedState = await getSession(nomor);
        const authState = {
      creds: savedState?.creds || initAuthCreds(),
      keys: makeCacheableSignalKeyStore(savedState?.keys || {}, pino({ level: "silent" }))
    };
        const usePairingCode = true;

        const sock = makeWASocket({
  logger: pino({ level: "silent" }),
  printQRInTerminal: false,
  auth: authState,
  browser: ["Ubuntu", "Chrome", "20.0.04"], // Gunakan browser yang lebih stabil
});

        // Event handler untuk koneksi
        sock.ev.on('connection.update', async (update) => {
      try {
        const { qr, connection, lastDisconnect } = update;
/*
        if (qr && !res.headersSent) {
          const qrImage = await QRCode.toDataURL(qr);
          return res.status(200).json({
            status: 'success',
            qrCode: qrImage,
            message: `QR code for ${nomor} generated successfully`,
          });
        }
*/
        if (connection === 'open') {
          console.log(`Connected to WhatsApp for nomor: ${nomor}`);
          // Simpan session saat berhasil login
          await saveSession(nomor, {
            creds: sock.authState.creds,
            keys: sock.authState.keys
          });
        }

        if (connection === 'close') {
          const reason = lastDisconnect?.error?.output?.statusCode || 'Unknown Reason';
          if (reason !== DisconnectReason.loggedOut) {
            await sleep(3000);
            await connectToWhatsApp();
          } else {
            await deleteSession(nomor);
          }
        }
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({ status: 'error', message: error.message });
        }
      }
    });

    // Simpan kredensial saat diperbarui (PENTING)
    sock.ev.on('creds.update', async () => {
      try {
        await saveSession(nomor, {
          creds: sock.authState.creds,
          keys: sock.authState.keys
        });
      } catch (err) {
        console.error(`Failed to save session:`, err.message);
      }
    });


        // Tambahkan error handler untuk socket
        sock.ev.on('connection.update', (update) => {
          if (update.error) {
            console.error('Socket error:', update.error);
          }
        });

        // Permintaan pairing code jika diperlukan
        if (usePairingCode && !sock.authState.creds.registered) {
  if (!res.headersSent) {
    try {
      await sleep(3000); // Beri waktu socket untuk inisialisasi
      const code = await sock.requestPairingCode(nomor);
      return res.status(200).json({
        status: 'success',
        pairingCode: code,
      });
    } catch (error) {
      console.error('Error pairing:', error);
    }
  }
} else if (sock.authState.creds.registered && !res.headersSent) {
  return res.status(200).json({
    status: 'success',
    message: 'Sudah terhubung'
  });
}
        
      } catch (error) {
        console.error(`Error during WhatsApp connection:`, error.message);
        if (!res.headersSent) {
          res.status(500).json({
            status: 'error',
            message: `Failed to connect to WhatsApp: ${error.message}`,
          });
        }
      }
    }

    await connectToWhatsApp();
  } catch (error) {
    console.error(`Error for nomor: ${req.query.nomor || 'unknown'} -`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ 
        status: 'error', 
        message: error.message 
      });
    }
  }
};
