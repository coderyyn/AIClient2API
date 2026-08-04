import { promises as fs } from 'fs';

function normalizeEmail(value) {
    return typeof value === 'string' ? value.trim() : '';
}

export function extractGeminiIdTokenEmail(idToken) {
    if (typeof idToken !== 'string') return '';
    const parts = idToken.split('.');
    if (parts.length < 2) return '';

    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload.email_verified === false) return '';
        return normalizeEmail(payload.email);
    } catch {
        return '';
    }
}

export function extractGeminiCredentialEmail(credentials = {}) {
    return normalizeEmail(credentials.email) || extractGeminiIdTokenEmail(credentials.id_token);
}

export async function readGeminiCredentialEmail(filePath) {
    if (!filePath) return '';
    try {
        const credentials = JSON.parse(await fs.readFile(filePath, 'utf8'));
        return extractGeminiCredentialEmail(credentials);
    } catch {
        return '';
    }
}
