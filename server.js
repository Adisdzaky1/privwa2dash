import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import API handlers
import sendHandler from './api/send.mjs';
import getcodeHandler from './api/getcode.mjs';

const app = express();

// Supabase clients
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('json spaces', 2);

// Trust proxy (important for Vercel)
app.set('trust proxy', 1);

// ==================== CRITICAL FIX: SESSION CONFIG ====================
const isProduction = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET || 'whatsgate-secret-key-change-this-production';

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProduction, // true in production, false in development
    httpOnly: true,
    sameSite: isProduction ? 'none' : 'lax', // 'none' for Vercel
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    path: '/'
  },
  store: isProduction ? undefined : new session.MemoryStore() // Use memory store for development
}));

// ==================== CRITICAL FIX: CORS CONFIG ====================
app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001',
      process.env.FRONTEND_URL,
      // Vercel domains
      /\.vercel\.app$/,
      /\.vercel\.domain$/
    ].filter(Boolean);
    
    if (allowedOrigins.some(allowed => {
      if (allowed instanceof RegExp) {
        return allowed.test(origin);
      }
      return allowed === origin;
    })) {
      callback(null, true);
    } else {
      console.warn('CORS blocked for origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true, // MUST BE TRUE FOR COOKIES
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'X-Requested-With'],
  exposedHeaders: ['set-cookie']
}));

// Handle preflight requests
app.options('*', cors());

// ==================== SECURITY MIDDLEWARES ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net", 
        "https://fonts.googleapis.com",
        "https://cdn.tailwindcss.com"
      ],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", 
        "https://cdn.jsdelivr.net", 
        "https://www.google.com", 
        "https://www.gstatic.com",
        "https://cdn.tailwindcss.com"
      ],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      frameSrc: ["https://www.google.com"],
      connectSrc: ["'self'", "https://www.google.com", "https://www.gstatic.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use(compression());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Logging
app.use(morgan(isProduction ? 'combined' : 'dev'));

// ==================== MIDDLEWARE ====================

// Auth middleware
const requireAuth = async (req, res, next) => {
  try {
    const token = req.cookies.access_token || req.headers.authorization?.replace('Bearer ', '');
    
    // If no token, redirect to login
    if (!token) {
      console.log('❌ No token found, redirecting to login');
      return res.redirect('/login');
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.log('❌ Invalid token:', error?.message);
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    // Get user data from database
    const { data: userData, error: dbError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', user.id)
      .single();

    if (dbError || !userData) {
      console.log('❌ User not found in database:', dbError?.message);
      res.clearCookie('access_token');
      return res.redirect('/login');
    }

    console.log('✅ Auth success:', userData.username);
    req.user = userData;
    req.supabaseUser = user;
    next();
  } catch (error) {
    console.error('❌ Auth middleware error:', error);
    res.clearCookie('access_token');
    res.redirect('/login');
  }
};

// Admin middleware
const requireAdmin = async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ==================== API KEY MIDDLEWARE ====================
const apiKeyAuth = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    
    if (!apiKey) {
      return res.status(401).json({
        status: 'error',
        message: 'API key required',
        code: 'MISSING_API_KEY'
      });
    }

    if (!apiKey.startsWith('wg_')) {
      return res.status(403).json({
        status: 'error',
        message: 'Invalid API key format',
        code: 'INVALID_FORMAT'
      });
    }

    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('api_key', apiKey)
      .single();

    if (error || !user) {
      console.log('❌ Invalid API key attempt:', apiKey);
      return res.status(403).json({
        status: 'error',
        message: 'Invalid API key',
        code: 'INVALID_API_KEY'
      });
    }

    console.log('✅ Valid API key for user:', user.username);

    // Check if email is verified
    try {
      const { data: authUser } = await supabase.auth.admin.getUserById(user.id);
      
      if (authUser?.user && !authUser.user.email_confirmed_at) {
        console.log('⚠️ Email not verified for:', user.username);
        return res.status(403).json({
          status: 'error',
          message: 'Please verify your email before using the API',
          code: 'EMAIL_NOT_VERIFIED'
        });
      }
    } catch (authCheckError) {
      console.log('⚠️ Could not verify email status:', authCheckError.message);
    }

    // Check plan expiration
    if (user.plan_expires_at) {
      const expiryDate = new Date(user.plan_expires_at);
      const now = new Date();
      
      if (now > expiryDate) {
        console.log('⏰ Plan expired for user:', user.username);
        
        await supabaseAdmin
          .from('users')
          .update({
            plan: 'free',
            daily_limit: 6,
            plan_expires_at: null
          })
          .eq('id', user.id);
        
        user.plan = 'free';
        user.daily_limit = 6;
        user.plan_expires_at = null;
      }
    }

    // Auto-reset daily requests if new day
    const today = new Date().toISOString().split('T')[0];
    
    if (user.last_reset_date !== today) {
      console.log('🔄 Resetting daily requests for:', user.username);
      
      await supabaseAdmin
        .from('users')
        .update({
          requests_used_today: 0,
          last_reset_date: today
        })
        .eq('id', user.id);
      
      user.requests_used_today = 0;
      user.last_reset_date = today;
    }

    // Check daily limit
    if (user.requests_used_today >= user.daily_limit) {
      console.log('🚫 Daily limit reached for:', user.username, 
                  `(${user.requests_used_today}/${user.daily_limit})`);
      
      return res.status(429).json({
        status: 'error',
        message: 'Daily request limit reached',
        code: 'RATE_LIMIT_EXCEEDED',
        limit: user.daily_limit,
        used: user.requests_used_today,
        reset_at: '06:00 AM tomorrow'
      });
    }

    // Increment request counter
    const newRequestCount = user.requests_used_today + 1;
    const newTotalRequests = user.total_requests + 1;
    
    console.log(`📊 Request ${newRequestCount}/${user.daily_limit} for ${user.username}`);
    
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({
        requests_used_today: newRequestCount,
        total_requests: newTotalRequests
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error updating request count:', updateError);
    }

    // Log API request
    await supabaseAdmin
      .from('api_logs')
      .insert({
        user_id: user.id,
        endpoint: req.path,
        method: req.method,
        ip_address: req.ip,
        user_agent: req.headers['user-agent'],
        response_status: 200
      });

    // Attach user to request
    req.apiUser = {
      ...user,
      requests_used_today: newRequestCount,
      total_requests: newTotalRequests
    };

    console.log(`✅ API request authorized: ${user.username} (${newRequestCount}/${user.daily_limit} used today)`);
    
    next();
  } catch (error) {
    console.error('❌ API auth error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Authentication failed',
      code: 'AUTH_ERROR'
    });
  }
};

// ==================== ROUTES ====================

// Home page
app.get('/', async (req, res) => {
  try {
    const { data: stats } = await supabaseAdmin
      .from('users')
      .select('total_requests');
    
    const totalRequests = stats?.reduce((sum, user) => sum + (user.total_requests || 0), 0) || 0;
    
    res.render('index', { 
      title: 'WhatsGate - Simple WhatsApp API',
      totalRequests 
    });
  } catch (error) {
    console.error('Home page error:', error);
    res.render('index', { 
      title: 'WhatsGate - Simple WhatsApp API',
      totalRequests: 0 
    });
  }
});

// Auth routes
app.get('/login', async (req, res) => {
  const token = req.cookies.access_token;
  
  if (token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (!error && user) {
        console.log('✅ Already logged in, redirecting to dashboard');
        return res.redirect('/dashboard');
      }
    } catch (error) {
      res.clearCookie('access_token');
    }
  }
  
  res.render('login', { 
    title: 'Login - WhatsGate',
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '6LdPSlEsAAAAADG81kKvOHpuA-sT4p7mQWaB8tML'
  });
});

app.get('/register', async (req, res) => {
  const token = req.cookies.access_token;
  
  if (token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      
      if (!error && user) {
        console.log('✅ Already logged in, redirecting to dashboard');
        return res.redirect('/dashboard');
      }
    } catch (error) {
      res.clearCookie('access_token');
    }
  }
  
  res.render('register', { 
    title: 'Register - WhatsGate',
    recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || '6LdPSlEsAAAAADG81kKvOHpuA-sT4p7mQWaB8tML'
  });
});

app.get('/verify-email', (req, res) => {
  res.render('verify-email', { title: 'Verify Email - WhatsGate' });
});

// ==================== CRITICAL FIX: LOGOUT ROUTE ====================
app.post('/auth/logout', async (req, res) => {
  try {
    console.log('🔄 Logout attempt received');
    
    // Clear Supabase session
    const token = req.cookies.access_token;
    if (token) {
      await supabase.auth.signOut();
      console.log('✅ Supabase session cleared');
    }
    
    // Clear all cookies
    const cookies = ['access_token', 'sb-access-token', 'sb-refresh-token'];
    cookies.forEach(cookieName => {
      res.clearCookie(cookieName, {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        path: '/',
        domain: isProduction ? '.vercel.app' : undefined
      });
    });
    
    // Destroy session
    req.session.destroy((err) => {
      if (err) {
        console.error('❌ Session destroy error:', err);
      }
    });
    
    console.log('✅ Logout successful');
    
    res.json({ 
      success: true, 
      message: 'Logged out successfully',
      redirect: '/login'
    });
    
  } catch (error) {
    console.error('❌ Logout error:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Logout failed',
      message: error.message 
    });
  }
});

// Register endpoint
app.post('/auth/register', async (req, res) => {
  try {
    const { email, password, fullName, username } = req.body;

    // Verify reCAPTCHA
    const recaptchaResponse = req.body['g-recaptcha-response'];
    const secretKey = process.env.RECAPTCHA_SECRET_KEY || '6LdPSlEsAAAAAJ8MIoT8bXxa4NZk33rgNZB7zbd4';
    
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${recaptchaResponse}`;
    const recaptchaResult = await axios.post(verifyUrl);
    
    if (!recaptchaResult.data.success) {
      return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }

    // Check if username exists
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('username')
      .eq('username', username)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    // Create auth user
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          username: username
        }
      }
    });

    if (authError) throw authError;

    // Generate API key
    const apiKey = 'wg_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);

    // Create user record
    const { error: dbError } = await supabaseAdmin
      .from('users')
      .insert({
        id: authData.user.id,
        email,
        username,
        full_name: fullName,
        api_key: apiKey,
        role: 'user',
        plan: 'free',
        daily_limit: 6,
        requests_used_today: 0,
        total_requests: 0,
        plan_expires_at: null,
        last_reset_date: new Date().toISOString().split('T')[0]
      });

    if (dbError) throw dbError;

    console.log('✅ New user registered:', username, '- Free plan (6 requests/day)');

    res.json({ 
      success: true, 
      message: 'Registration successful! Please check your email to verify your account.' 
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Login endpoint
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Verify reCAPTCHA
    const recaptchaResponse = req.body['g-recaptcha-response'];
    const secretKey = process.env.RECAPTCHA_SECRET_KEY || '6LdPSlEsAAAAAJ8MIoT8bXxa4NZk33rgNZB7zbd4';
    
    const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${recaptchaResponse}`;
    const recaptchaResult = await axios.post(verifyUrl);
    
    if (!recaptchaResult.data.success) {
      return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    // Check if email is verified
    if (!data.user.email_confirmed_at) {
      return res.status(403).json({ 
        error: 'Please verify your email before logging in' 
      });
    }

    // Set cookie with proper configuration
    res.cookie('access_token', data.session.access_token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    });

    res.json({ success: true, redirectUrl: '/dashboard' });
  } catch (error) {
    console.error('Login error:', error);
    res.status(400).json({ error: error.message });
  }
});

// Dashboard
app.get('/dashboard', requireAuth, async (req, res) => {
  try {
    // Get user stats
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('total_requests');
    
    const totalRequestsAllUsers = allUsers?.reduce((sum, user) => sum + (user.total_requests || 0), 0) || 0;

    // Reset daily limit if needed
    const today = new Date().toISOString().split('T')[0];
    if (req.user.last_reset_date !== today) {
      await supabaseAdmin
        .from('users')
        .update({
          requests_used_today: 0,
          last_reset_date: today
        })
        .eq('id', req.user.id);
      
      req.user.requests_used_today = 0;
    }

    // Get recent logs
    const { data: recentLogs } = await supabaseAdmin
      .from('api_logs')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(10);

    res.render('dashboard', {
      title: 'Dashboard - WhatsGate',
      user: req.user,
      totalRequestsAllUsers,
      recentLogs: recentLogs || []
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Admin panel
app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { data: users } = await supabaseAdmin
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    res.render('admin', {
      title: 'Admin Panel - WhatsGate',
      user: req.user,
      users: users || []
    });
  } catch (error) {
    console.error('Admin error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Admin: Update user plan
app.post('/admin/update-plan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId, plan, dailyLimit, planDays } = req.body;

    const updates = {
      plan,
      daily_limit: parseInt(dailyLimit)
    };

    if (planDays && parseInt(planDays) > 0) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + parseInt(planDays));
      updates.plan_expires_at = expiresAt.toISOString();
    } else {
      updates.plan_expires_at = null;
    }

    const { error } = await supabaseAdmin
      .from('users')
      .update(updates)
      .eq('id', userId);

    if (error) throw error;

    console.log('✅ Plan updated by admin:', userId, updates);

    res.json({ success: true, message: 'Plan updated successfully' });
  } catch (error) {
    console.error('Update plan error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Admin: Delete user
app.delete('/admin/user/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const { error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('Delete user error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get user stats
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const { data: allUsers } = await supabaseAdmin
      .from('users')
      .select('total_requests, requests_used_today');
    
    const totalRequests = allUsers?.reduce((sum, user) => sum + (user.total_requests || 0), 0) || 0;
    const todayRequests = allUsers?.reduce((sum, user) => sum + (user.requests_used_today || 0), 0) || 0;

    res.json({
      success: true,
      data: {
        user: {
          daily_limit: req.user.daily_limit,
          requests_used_today: req.user.requests_used_today,
          total_requests: req.user.total_requests,
          plan: req.user.plan,
          plan_expires_at: req.user.plan_expires_at
        },
        global: {
          total_requests: totalRequests,
          today_requests: todayRequests
        }
      }
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== API ENDPOINTS ====================
app.get('/api/send', apiKeyAuth, sendHandler);
app.get('/api/getcode', apiKeyAuth, getcodeHandler);

// Test endpoint to check API key status
app.get('/api/check-limit', apiKeyAuth, (req, res) => {
  res.json({
    status: 'success',
    user: req.apiUser.username,
    plan: req.apiUser.plan,
    daily_limit: req.apiUser.daily_limit,
    requests_used_today: req.apiUser.requests_used_today,
    requests_remaining: req.apiUser.daily_limit - req.apiUser.requests_used_today,
    total_requests: req.apiUser.total_requests
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).render('404', { title: '404 - Page Not Found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res, next) => {
    // Untuk routes yang memerlukan autentikasi
    if (req.session.userId) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
    next();
});

// Start server
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`
    ============================================
    WhatsGate API Server
    ============================================
    Status: 🟢 Online
    Port: ${PORT}
    Environment: ${process.env.NODE_ENV || 'development'}
    Session Config: ${isProduction ? 'Production' : 'Development'}
    ============================================
    `);
  });
}

export default app;
