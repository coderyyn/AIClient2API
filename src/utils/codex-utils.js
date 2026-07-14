import { promises as fs } from 'fs';

const DEFAULT_CODEX_REDIRECT_PORT = 1455;

export function buildCodexRedirectUri(hostHeader, callbackPort = DEFAULT_CODEX_REDIRECT_PORT) {
    return `http://localhost:${callbackPort}/auth/callback`;
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function extractCodexCredentialDisplayName(credentialData, fallback = '') {
    if (!credentialData || typeof credentialData !== 'object') {
        return cleanString(fallback);
    }

    const candidates = [
        credentialData.customName,
        credentialData.email,
        credentialData.name,
        credentialData?.profile?.email,
        credentialData?.extra?.email,
        credentialData?.user?.email
    ];

    for (const candidate of candidates) {
        const value = cleanString(candidate);
        if (value) return value;
    }

    return cleanString(fallback);
}

export function extractCodexCredentialIdentity(credentialData) {
    if (!credentialData || typeof credentialData !== 'object') {
        return {
            codexAccountKey: '',
            codexAccountId: '',
            codexEmail: ''
        };
    }

    const authClaims = credentialData?.claims?.['https://api.openai.com/auth']
        || credentialData?.id_token_claims?.['https://api.openai.com/auth']
        || credentialData?.auth?.['https://api.openai.com/auth']
        || {};
    const codexAccountId = cleanString(
        credentialData.account_id
        || credentialData.chatgpt_account_id
        || authClaims.chatgpt_account_id
        || credentialData?.profile?.account_id
        || credentialData?.user?.account_id
    );
    const codexEmail = cleanString(
        credentialData.email
        || credentialData?.profile?.email
        || credentialData?.extra?.email
        || credentialData?.user?.email
        || credentialData.name
    ).toLowerCase();

    return {
        codexAccountKey: codexAccountId || codexEmail,
        codexAccountId,
        codexEmail
    };
}

export async function readCodexCredentialDisplayName(filePath, fallback = '') {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) {
        return cleanString(fallback);
    }

    try {
        const content = await fs.readFile(resolvedPath, 'utf8');
        const data = JSON.parse(content);
        return extractCodexCredentialDisplayName(data, fallback);
    } catch {
        return cleanString(fallback);
    }
}

export async function readCodexCredentialIdentity(filePath) {
    const resolvedPath = cleanString(filePath);
    if (!resolvedPath) {
        return extractCodexCredentialIdentity(null);
    }

    try {
        const content = await fs.readFile(resolvedPath, 'utf8');
        const data = JSON.parse(content);
        return extractCodexCredentialIdentity(data);
    } catch {
        return extractCodexCredentialIdentity(null);
    }
}
