const { createClient } = require('@supabase/supabase-js');

let client = null;
let authClient = null;

function getSupabaseUrl() {
  return (process.env.SUPABASE_URL || '').trim().replace(/^["']|["']$/g, '');
}

function getSupabaseKey() {
  const raw = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  return raw.trim().replace(/^["']|["']$/g, '');
}

function getAnonKey() {
  const raw = process.env.SUPABASE_ANON_KEY || '';
  return raw.trim().replace(/^["']|["']$/g, '');
}

function isSupabaseConfigured() {
  return Boolean(getSupabaseUrl() && getSupabaseKey());
}

function isSupabaseAuthConfigured() {
  return Boolean(getSupabaseUrl() && getAnonKey());
}

function getClient() {
  if (!isSupabaseConfigured()) return null;
  if (!client) {
    client = createClient(getSupabaseUrl(), getSupabaseKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return client;
}

function getAuthClient() {
  if (!isSupabaseAuthConfigured()) return null;
  if (!authClient) {
    authClient = createClient(getSupabaseUrl(), getAnonKey(), {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return authClient;
}

function mapSupabaseAuthUser(user, fallbackName = '') {
  const meta = user?.user_metadata || {};
  const email = user?.email || '';
  return {
    id: user.id,
    email,
    name: meta.name || meta.full_name || fallbackName || email.split('@')[0] || 'User',
    picture: meta.avatar_url || meta.picture || null,
    provider: 'email',
    plan: 'free'
  };
}

function formatAuthError(error) {
  const code = error?.code || '';
  const message = error?.message || 'Authentication failed.';
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return 'Incorrect email or password.';
  }
  if (code === 'user_already_registered' || /already registered/i.test(message)) {
    return 'An account with this email already exists. Sign in instead.';
  }
  if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'Check your email and confirm your account before signing in.';
  }
  return message;
}

async function signInWithEmail(email, password) {
  const sb = getAuthClient();
  if (!sb) return null;
  const { data, error } = await sb.auth.signInWithPassword({
    email: String(email).trim().toLowerCase(),
    password
  });
  if (error) {
    const err = new Error(formatAuthError(error));
    err.code = error.code;
    throw err;
  }
  if (!data.user) throw new Error('Sign in failed.');
  return {
    user: mapSupabaseAuthUser(data.user),
    session: data.session || null
  };
}

async function signUpWithEmail(email, password, name) {
  const sb = getAuthClient();
  if (!sb) return null;
  const cleanEmail = String(email).trim().toLowerCase();
  const displayName = String(name || cleanEmail.split('@')[0]).trim();
  const { data, error } = await sb.auth.signUp({
    email: cleanEmail,
    password,
    options: {
      data: { name: displayName, full_name: displayName }
    }
  });
  if (error) {
    const err = new Error(formatAuthError(error));
    err.code = error.code;
    throw err;
  }
  if (!data.user) throw new Error('Sign up failed.');
  return {
    user: mapSupabaseAuthUser(data.user, displayName),
    session: data.session || null,
    needsEmailConfirmation: !data.session
  };
}

function mapSessionRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    source: row.source || '',
    notes: row.notes || null,
    quiz: row.quiz || null,
    flashcards: row.flashcards || [],
    podcast: row.podcast || null,
    sourceText: row.source_text || '',
    cardCount: row.card_count || 0,
    quizCount: row.quiz_count || 0,
    tutorDone: Boolean(row.tutor_done),
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

function mapFolderRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now()
  };
}

function mapDeckRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    folderId: row.folder_id || null,
    name: row.name,
    cards: Array.isArray(row.cards) ? row.cards : [],
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now()
  };
}

async function listStudySessions(ownerId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('study_sessions')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data || []).map(mapSessionRow);
}

async function getStudySession(ownerId, id) {
  const sb = getClient();
  const { data, error } = await sb
    .from('study_sessions')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return mapSessionRow(data);
}

async function upsertStudySession(ownerId, session) {
  const sb = getClient();
  const now = new Date().toISOString();
  const row = {
    id: session.id,
    owner_id: ownerId,
    name: session.name || 'Study session',
    source: session.source || '',
    notes: session.notes || null,
    quiz: session.quiz || null,
    flashcards: session.flashcards || [],
    podcast: session.podcast || null,
    source_text: (session.sourceText || '').slice(0, 50000),
    card_count: session.cardCount || (session.flashcards?.length ?? 0),
    quiz_count: session.quizCount || (session.quiz?.questions?.length ?? 0),
    tutor_done: Boolean(session.tutorDone),
    updated_at: now
  };
  const { data, error } = await sb
    .from('study_sessions')
    .upsert({ ...row, created_at: session.createdAt ? new Date(session.createdAt).toISOString() : now })
    .select('*')
    .single();
  if (error) throw error;
  return mapSessionRow(data);
}

async function deleteStudySession(ownerId, id) {
  const sb = getClient();
  const { error } = await sb
    .from('study_sessions')
    .delete()
    .eq('owner_id', ownerId)
    .eq('id', id);
  if (error) throw error;
}

async function listFolders(ownerId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('folders')
    .select('*')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapFolderRow);
}

async function upsertFolder(ownerId, folder) {
  const sb = getClient();
  const row = {
    id: folder.id,
    owner_id: ownerId,
    name: folder.name,
    description: folder.description || ''
  };
  const { data, error } = await sb
    .from('folders')
    .upsert({ ...row, created_at: folder.createdAt ? new Date(folder.createdAt).toISOString() : new Date().toISOString() })
    .select('*')
    .single();
  if (error) throw error;
  return mapFolderRow(data);
}

async function deleteFolder(ownerId, id) {
  const sb = getClient();
  const { error } = await sb
    .from('folders')
    .delete()
    .eq('owner_id', ownerId)
    .eq('id', id);
  if (error) throw error;
}

async function listDecks(ownerId) {
  const sb = getClient();
  const { data, error } = await sb
    .from('decks')
    .select('*')
    .eq('owner_id', ownerId)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapDeckRow);
}

async function upsertDeck(ownerId, deck) {
  const sb = getClient();
  const now = new Date().toISOString();
  const row = {
    id: deck.id,
    owner_id: ownerId,
    folder_id: deck.folderId || null,
    name: deck.name,
    cards: deck.cards || [],
    updated_at: now
  };
  const { data, error } = await sb
    .from('decks')
    .upsert({ ...row, created_at: deck.createdAt ? new Date(deck.createdAt).toISOString() : now })
    .select('*')
    .single();
  if (error) throw error;
  return mapDeckRow(data);
}

async function deleteDeck(ownerId, id) {
  const sb = getClient();
  const { error } = await sb
    .from('decks')
    .delete()
    .eq('owner_id', ownerId)
    .eq('id', id);
  if (error) throw error;
}

function mapProfileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || '',
    name: row.name || '',
    picture: row.picture || null,
    provider: row.provider || 'email',
    plan: row.plan || 'free',
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
    lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).getTime() : null
  };
}

async function upsertProfile(profile) {
  const sb = getClient();
  const now = new Date().toISOString();
  const row = {
    id: profile.id,
    email: profile.email || null,
    name: profile.name || profile.email || 'User',
    picture: profile.picture || null,
    provider: profile.provider || 'email',
    plan: profile.plan || 'free',
    updated_at: now,
    last_sign_in_at: now
  };
  const { data, error } = await sb
    .from('profiles')
    .upsert(row)
    .select('*')
    .single();
  if (error) throw error;
  return mapProfileRow(data);
}

async function getProfile(id) {
  const sb = getClient();
  const { data, error } = await sb.from('profiles').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return mapProfileRow(data);
}

async function migrateGuestData(guestId, userId) {
  if (!guestId || !userId || guestId === userId) return { migrated: 0 };
  const sb = getClient();
  const tables = ['study_sessions', 'folders', 'decks'];
  let migrated = 0;
  for (const table of tables) {
    const { data, error } = await sb.from(table).update({ owner_id: userId }).eq('owner_id', guestId).select('id');
    if (error) throw error;
    migrated += data?.length || 0;
  }
  return { migrated };
}

async function verifyConnection() {
  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'not_configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env' };
  }
  try {
    const sb = getClient();
    const { error } = await sb.from('profiles').select('id').limit(1);
    if (error) {
      if (/relation.*does not exist/i.test(error.message)) {
        return { ok: false, reason: 'schema', message: 'Tables missing. Run supabase/schema.sql in the Supabase SQL editor.' };
      }
      return { ok: false, reason: 'error', message: error.message };
    }
    return { ok: true, message: 'Supabase connected' };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message || 'Supabase unavailable' };
  }
}

module.exports = {
  isSupabaseConfigured,
  isSupabaseAuthConfigured,
  verifyConnection,
  signInWithEmail,
  signUpWithEmail,
  upsertProfile,
  getProfile,
  migrateGuestData,
  listStudySessions,
  getStudySession,
  upsertStudySession,
  deleteStudySession,
  listFolders,
  upsertFolder,
  deleteFolder,
  listDecks,
  upsertDeck,
  deleteDeck
};
