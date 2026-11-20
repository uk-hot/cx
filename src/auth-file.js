import { createHash } from "node:crypto";

/**
 * The login a ChatGPT auth.json belongs to.
 * @typedef {object} AuthIdentity
 * @property {string} accountKey `${userId}::${accountId}`, the registry key
 * @property {string} userId
 * @property {string} accountId
 * @property {string | null} email only the id_token carries it
 * @property {string} authMode
 */

/**
 * Claims of a JWT, without verifying it: cx only reads its own tokens.
 * @param {unknown} token
 * @returns {Record<string, any> | null}
 */
export function decodeJwtPayload(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {any} authData parsed auth.json
 * @returns {AuthIdentity | null}
 */
export function parseAuthFile(authData) {
  if (!authData?.tokens) {
    return null;
  }
  // An API-key login may still carry tokens from an earlier ChatGPT login;
  // those do not identify the account that is actually in use.
  if (String(authData.auth_mode ?? "").toLowerCase() === "apikey") {
    return null;
  }
  const { tokens } = authData;
  const accountId = tokens.account_id;
  if (!accountId) {
    return null;
  }

  const idTokenClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
  const accessTokenClaims = !idTokenClaims && tokens.access_token ? decodeJwtPayload(tokens.access_token) : null;
  const userId = idTokenClaims?.sub ?? accessTokenClaims?.sub ?? null;
  if (!userId) {
    return null;
  }

  return {
    accountKey: `${userId}::${accountId}`,
    userId,
    accountId,
    email: idTokenClaims?.email ?? null,
    authMode: authData.auth_mode ?? "chatgpt"
  };
}

/**
 * auth.json that is not in the OpenAI OAuth format is fine for third-party logins.
 * @param {string | null} authText
 */
export function parseAuthText(authText) {
  if (authText === null) {
    return null;
  }
  try {
    return parseAuthFile(JSON.parse(authText));
  } catch {
    return null;
  }
}

/**
 * The ids Codex 0.168+ tags a thread with when this login creates it
 * (creator_user_id, creator_account_id). The user id is ChatGPT's "user-..."
 * id from the tokens' auth claim, not the sign-in `sub` the registry keys on.
 * @param {string | null} authText
 * @returns {{ userId: string | null, accountId: string } | null}
 */
export function creatorIdsOf(authText) {
  let tokens;
  try {
    tokens = JSON.parse(authText ?? "null")?.tokens;
  } catch {
    return null;
  }
  if (!tokens) {
    return null;
  }
  for (const token of [tokens.id_token, tokens.access_token]) {
    const claim = decodeJwtPayload(token)?.["https://api.openai.com/auth"];
    const accountId = claim?.chatgpt_account_id ?? tokens.account_id;
    const userId = claim?.chatgpt_user_id ?? claim?.user_id ?? null;
    if (typeof accountId === "string" && accountId && typeof userId === "string") {
      return { userId, accountId };
    }
  }
  return typeof tokens.account_id === "string" && tokens.account_id ? { userId: null, accountId: tokens.account_id } : null;
}

/**
 * Identifies a non-OAuth login (which has no account key) without storing the
 * API key itself in the registry.
 * @param {string} authText
 */
export function authDigest(authText) {
  return createHash("sha256").update(authText).digest("hex");
}
