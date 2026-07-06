/**
 * API 大锅饭 - 管理 API 路由
 * 提供 Key 管理的 RESTful API
 */

import {
    createKey,
    listKeys,
    getKey,
    deleteKey,
    updateKeyLimit,
    resetKeyUsage,
    resetKeyTokenStats,
    toggleKey,
    updateKeyName,
    regenerateKey,
    getStats,
    getAccountUsageSummary,
    validateKey,
    KEY_PREFIX,
    applyDailyLimitToAllKeys,
    getAllKeyIds,
    resetAllTokenStats
} from './key-manager.js';
import { getRequestBody } from '../../utils/common.js';
import { extractCodexCredentialIdentity } from '../../utils/codex-utils.js';
import { readLedgerRangeStats, resolveRangeDates } from './ledger-range-stats.js';
import logger from '../../utils/logger.js';
import fs from 'fs';
import path from 'path';

const STATS_CACHE_TTL_MS = 30 * 1000;
const statsCache = new Map();

/**
 * 发送 JSON 响应
 */
function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function getRequestCostOptions(req) {
    try {
        const url = new URL(req.url || '', 'http://localhost');
        return {
            conversionModel: url.searchParams.get('conversionModel') || undefined
        };
    } catch {
        return {};
    }
}

function getStatsCacheKey(costOptions = {}) {
    return [
        costOptions.conversionModel || '',
        costOptions.compactHistory ? 'compact-history' : 'full-history',
        costOptions.compactAccounts ? 'compact-accounts' : 'full-accounts'
    ].join(':');
}

function clearStatsCache() {
    statsCache.clear();
}

function getCachedStats(costOptions = {}) {
    const cacheKey = getStatsCacheKey(costOptions);
    const now = Date.now();
    const entry = statsCache.get(cacheKey);
    if (entry?.value && now - entry.createdAt < STATS_CACHE_TTL_MS) return entry.value;
    if (entry?.promise) return entry.promise;

    const promise = getStats(costOptions)
        .then(stats => {
            statsCache.set(cacheKey, { value: stats, createdAt: Date.now() });
            return stats;
        })
        .catch(error => {
            statsCache.delete(cacheKey);
            throw error;
        });
    statsCache.set(cacheKey, { promise, createdAt: now });
    return promise;
}

function compactUsageHistoryForList(usageHistory = {}) {
    const compact = { usageHistory: {} };
    for (const [date, day] of Object.entries(usageHistory || {})) {
        compact.usageHistory[date] = { summary: day?.summary || {} };
        delete compact.usageHistory[date].providers;
        delete compact.usageHistory[date].models;
        delete compact.usageHistory[date].accounts;
        delete compact.usageHistory[date].hours;
    }
    return compact.usageHistory;
}

function compactKeyForList(key) {
    return {
        ...key,
        usageHistory: compactUsageHistoryForList(key.usageHistory || {})
    };
}

function formatDailyLimitMessage(dailyLimit) {
    return dailyLimit === 0 ? '不限量' : dailyLimit;
}

function readProviderCredentialEmail(provider) {
    const credPath = provider?.CODEX_OAUTH_CREDS_FILE_PATH;
    if (!credPath) return '';
    const resolvedPath = path.isAbsolute(credPath) ? credPath : path.join(process.cwd(), credPath);
    if (!fs.existsSync(resolvedPath)) return '';
    try {
        const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        return extractCodexCredentialIdentity(data).codexEmail || '';
    } catch {
        return '';
    }
}

function loadProviderEmailIndex() {
    const index = new Map();

    try {
        const filePath = path.join(process.cwd(), 'configs', 'provider_pools.json');
        if (fs.existsSync(filePath)) {
            const providerPools = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            for (const [providerType, providers] of Object.entries(providerPools || {})) {
                if (!Array.isArray(providers)) continue;
                for (const provider of providers) {
                    if (!provider?.uuid) continue;
                    const email = provider.codexEmail || readProviderCredentialEmail(provider);
                    if (!email) continue;
                    index.set(`${providerType}:${provider.uuid}`, email);
                }
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load provider pool email index:', error.message);
    }

    try {
        const cachePath = path.join(process.cwd(), 'configs', 'usage-cache.json');
        if (!fs.existsSync(cachePath)) return index;
        const usageCache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [providerType, providerUsage] of Object.entries(usageCache?.providers || {})) {
            const instances = Array.isArray(providerUsage?.instances) ? providerUsage.instances : [];
            for (const instance of instances) {
                const email = instance?.usage?.user?.email || instance?.usage?.user?.label || instance?.codexEmail;
                if (!instance?.uuid || !email) continue;
                index.set(`${providerType}:${instance.uuid}`, email);
            }
        }
    } catch (error) {
        logger.warn('[API Potluck] Failed to load usage cache email index:', error.message);
    }

    return index;
}

function enrichAccountWithEmail(account, providerEmailIndex) {
    if (!account || account.accountEmail) return account;
    const provider = account.provider || null;
    const candidates = Array.isArray(account.providerUuids) && account.providerUuids.length > 0
        ? account.providerUuids
        : [account.providerUuid].filter(Boolean);
    for (const uuid of candidates) {
        const email = providerEmailIndex.get(`${provider}:${uuid}`);
        if (email) {
            account.accountEmail = email;
            break;
        }
    }
    return account;
}

function enrichPotluckStatsAccountEmails(stats) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return stats;

    for (const day of Object.values(stats?.usageHistory || {})) {
        for (const account of Object.values(day?.accounts || {})) {
            enrichAccountWithEmail(account, providerEmailIndex);
        }
        for (const hour of Object.values(day?.hours || {})) {
            for (const account of Object.values(hour?.accounts || {})) {
                enrichAccountWithEmail(account, providerEmailIndex);
            }
        }
    }
    return stats;
}

async function loadLedgerRangeStatsForRange(range, conversionModel) {
    const ledgerDailyDir = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'daily');
    const dates = resolveRangeDates(range, { ledgerDailyDir });
    const stats = await readLedgerRangeStats({ ledgerDailyDir, dates, conversionModel });
    return { range, dates, source: 'ledger', ...stats };
}

function readReconciliationLatest() {
    try {
        const filePath = path.join(process.cwd(), 'configs', 'permanent-usage-ledger', 'reconciliation', 'latest.json');
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.warn('[API Potluck] Failed to read reconciliation latest:', error.message);
        return null;
    }
}

function enrichAccountUsageSummaryEmails(summary) {
    const providerEmailIndex = loadProviderEmailIndex();
    if (providerEmailIndex.size === 0) return summary;
    for (const account of summary?.accounts || []) {
        enrichAccountWithEmail(account, providerEmailIndex);
    }
    return summary;
}

/**
 * 验证管理员 Token
 * @param {http.IncomingMessage} req
 * @returns {Promise<boolean>}
 */
async function checkAdminAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    
    // 动态导入 ui-manager 中的 token 验证逻辑
    try {
        const { existsSync, readFileSync } = await import('fs');
        const { promises: fs } = await import('fs');
        const path = await import('path');
        
        const TOKEN_STORE_FILE = path.join(process.cwd(), 'configs', 'token-store.json');
        
        if (!existsSync(TOKEN_STORE_FILE)) {
            return false;
        }
        
        const content = readFileSync(TOKEN_STORE_FILE, 'utf8');
        const tokenStore = JSON.parse(content);
        const token = authHeader.substring(7);
        const tokenInfo = tokenStore.tokens[token];
        
        if (!tokenInfo) {
            return false;
        }
        
        // 检查是否过期
        if (Date.now() > tokenInfo.expiryTime) {
            return false;
        }
        
        return true;
    } catch (error) {
        logger.error('[API Potluck] Auth check error:', error.message);
        return false;
    }
}

/**
 * 处理 Potluck 管理 API 请求
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckApiRoutes(method, path, req, res) {
    // 只处理 /api/potluck 开头的请求
    if (!path.startsWith('/api/potluck')) {
        return false;
    }
    logger.info('[API Potluck] Handling request:', method, path);
    
    // 验证管理员权限
    const isAuthed = await checkAdminAuth(req);
    if (!isAuthed) {
        sendJson(res, 401, { 
            success: false, 
            error: { message: '未授权：请先登录', code: 'UNAUTHORIZED' } 
        });
        return true;
    }

    try {
        // GET /api/potluck/stats - 获取统计信息
        if (method === 'GET' && path === '/api/potluck/stats') {
            const stats = enrichPotluckStatsAccountEmails(await getCachedStats(getRequestCostOptions(req)));
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        // GET /api/potluck/range-stats - 从 ledger 预聚合读取区间统计（管理页分布数据源）
        if (method === 'GET' && path === '/api/potluck/range-stats') {
            const url = new URL(req.url || '', 'http://localhost');
            const range = ['total', '30d', '7d', 'today'].includes(url.searchParams.get('range'))
                ? url.searchParams.get('range')
                : '7d';
            const conversionModel = url.searchParams.get('conversionModel') || undefined;
            const data = await loadLedgerRangeStatsForRange(range, conversionModel);
            sendJson(res, 200, { success: true, data });
            return true;
        }

        // GET /api/potluck/reconciliation - 获取最近一次每日用量对账结果
        if (method === 'GET' && path === '/api/potluck/reconciliation') {
            const latest = readReconciliationLatest();
            sendJson(res, 200, {
                success: true,
                data: { available: latest !== null, result: latest }
            });
            return true;
        }

        // GET /api/potluck/account-usage-summary - 获取账号维度真实用量摘要
        if (method === 'GET' && path === '/api/potluck/account-usage-summary') {
            const summary = enrichAccountUsageSummaryEmails(await getAccountUsageSummary());
            sendJson(res, 200, { success: true, data: summary });
            return true;
        }

        // POST /api/potluck/stats/reset-tokens - 重置全部 Key 的 Token 统计
        if (method === 'POST' && path === '/api/potluck/stats/reset-tokens') {
            const result = await resetAllTokenStats();
            clearStatsCache();
            const stats = enrichPotluckStatsAccountEmails(await getStats(getRequestCostOptions(req)));
            sendJson(res, 200, {
                success: true,
                message: `已重置 ${result.updated}/${result.total} 个 Key 的 Token 统计`,
                data: stats
            });
            return true;
        }

        // GET /api/potluck/keys - 获取所有 Key 列表
        if (method === 'GET' && path === '/api/potluck/keys') {
            const costOptions = getRequestCostOptions(req);
            const keys = await listKeys({ ...costOptions, summaryOnly: true, compactCosts: true });
            const stats = await getCachedStats({ ...costOptions, compactHistory: true, compactAccounts: true });
            sendJson(res, 200, { 
                success: true, 
                data: { keys: keys.map(compactKeyForList), stats }
            });
            return true;
        }

        // POST /api/potluck/keys/apply-limit - 批量应用每日限额到所有 Key
        if (method === 'POST' && path === '/api/potluck/keys/apply-limit') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { dailyLimit } = body;
            
            if (dailyLimit === undefined || typeof dailyLimit !== 'number' || dailyLimit < 0) {
                sendJson(res, 400, { success: false, error: { message: 'dailyLimit 必须是一个非负数，0 表示不限量' } });
                return true;
            }
            
            const result = await applyDailyLimitToAllKeys(dailyLimit);
            sendJson(res, 200, {
                success: true,
                message: `已将每日限额 ${formatDailyLimitMessage(dailyLimit)} 应用到 ${result.updated}/${result.total} 个 Key`,
                data: result
            });
            return true;
        }

        // POST /api/potluck/keys - 创建新 Key
        if (method === 'POST' && path === '/api/potluck/keys') {
            const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
            const { name, dailyLimit } = body;
            const keyData = await createKey(name, dailyLimit);
            sendJson(res, 201, {
                success: true,
                message: 'API Key 创建成功',
                data: keyData
            });
            return true;
        }

        // 处理带 keyId 的路由
        const keyIdMatch = path.match(/^\/api\/potluck\/keys\/([^\/]+)(\/.*)?$/);
        if (keyIdMatch) {
            const keyId = decodeURIComponent(keyIdMatch[1]);
            const subPath = keyIdMatch[2] || '';

            // GET /api/potluck/keys/:keyId - 获取单个 Key 详情
            if (method === 'GET' && !subPath) {
                const keyData = await getKey(keyId, getRequestCostOptions(req));
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { success: true, data: keyData });
                return true;
            }

            // DELETE /api/potluck/keys/:keyId - 删除 Key
            if (method === 'DELETE' && !subPath) {
                const deleted = await deleteKey(keyId);
                if (!deleted) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { success: true, message: 'Key 删除成功' });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/limit - 更新每日限额
            if (method === 'PUT' && subPath === '/limit') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { dailyLimit } = body;
                
                if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的每日限额值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyLimit(keyId, dailyLimit);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { 
                    success: true, 
                    message: '每日限额更新成功',
                    data: keyData 
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset - 重置当天调用次数
            if (method === 'POST' && subPath === '/reset') {
                const keyData = await resetKeyUsage(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { 
                    success: true, 
                    message: '使用量重置成功',
                    data: keyData 
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/reset-tokens - 重置 Token 统计
            if (method === 'POST' && subPath === '/reset-tokens') {
                const keyData = await resetKeyTokenStats(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, {
                    success: true,
                    message: 'Token 统计重置成功',
                    data: keyData
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/toggle - 切换启用/禁用状态
            if (method === 'POST' && subPath === '/toggle') {
                const keyData = await toggleKey(keyId);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { 
                    success: true, 
                    message: `Key 已成功${keyData.enabled ? '启用' : '禁用'}`,
                    data: keyData 
                });
                return true;
            }

            // PUT /api/potluck/keys/:keyId/name - 更新 Key 名称
            if (method === 'PUT' && subPath === '/name') {
                const body = await getRequestBody(req, { maxBytes: 1024 * 1024 });
                const { name } = body;
                
                if (!name || typeof name !== 'string') {
                    sendJson(res, 400, { 
                        success: false, 
                        error: { message: '无效的名称值' } 
                    });
                    return true;
                }

                const keyData = await updateKeyName(keyId, name);
                if (!keyData) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { 
                    success: true, 
                    message: '名称更新成功',
                    data: keyData 
                });
                return true;
            }

            // POST /api/potluck/keys/:keyId/regenerate - 重新生成 Key
            if (method === 'POST' && subPath === '/regenerate') {
                const result = await regenerateKey(keyId);
                if (!result) {
                    sendJson(res, 404, { success: false, error: { message: '未找到 Key' } });
                    return true;
                }
                sendJson(res, 200, { 
                    success: true, 
                    message: 'Key 重新生成成功',
                    data: {
                        oldKey: result.oldKey,
                        newKey: result.newKey,
                        keyData: result.keyData
                    }
                });
                return true;
            }
        }

        // 未匹配的 potluck 路由
        sendJson(res, 404, { success: false, error: { message: '未找到 Potluck API 端点' } });
        return true;

    } catch (error) {
        logger.error('[API Potluck] API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}

/**
 * 从请求中提取 Potluck API Key
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @returns {string|null}
 */
function extractApiKeyFromRequest(req) {
    // 1. 检查 Authorization header
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token.startsWith(KEY_PREFIX)) {
            return token;
        }
    }

    // 2. 检查 x-api-key header
    const xApiKey = req.headers['x-api-key'];
    if (xApiKey && xApiKey.startsWith(KEY_PREFIX)) {
        return xApiKey;
    }

    return null;
}

/**
 * 处理用户端 API 请求 - 用户通过自己的 API Key 查询使用量
 * @param {string} method - HTTP 方法
 * @param {string} path - 请求路径
 * @param {http.IncomingMessage} req - HTTP 请求对象
 * @param {http.ServerResponse} res - HTTP 响应对象
 * @returns {Promise<boolean>} - 是否处理了请求
 */
export async function handlePotluckUserApiRoutes(method, path, req, res) {
    // 只处理 /api/potluckuser 开头的请求
    if (!path.startsWith('/api/potluckuser')) {
        return false;
    }
    logger.info('[API Potluck User] Handling request:', method, path);

    try {
        // 从请求中提取 API Key
        const apiKey = extractApiKeyFromRequest(req);
        
        if (!apiKey) {
            sendJson(res, 401, {
                success: false,
                error: {
                    message: '需要 API Key。请在 Authorization 标头 (Bearer maki_xxx) 或 x-api-key 标头中提供您的 API Key。',
                    code: 'API_KEY_REQUIRED'
                }
            });
            return true;
        }

        // 验证 API Key
        const validation = await validateKey(apiKey);
        
        if (!validation.valid && validation.reason !== 'quota_exceeded') {
            const errorMessages = {
                'invalid_format': 'API Key 格式无效',
                'not_found': '未找到 API Key',
                'disabled': 'API Key 已禁用'
            };
            
            sendJson(res, 401, {
                success: false,
                error: {
                    message: errorMessages[validation.reason] || '无效的 API Key',
                    code: validation.reason
                }
            });
            return true;
        }

        // GET /api/potluckuser/usage - 获取当前用户的使用量信息
        if (method === 'GET' && path === '/api/potluckuser/usage') {
            const keyData = await getKey(apiKey);
            
            if (!keyData) {
                sendJson(res, 404, {
                    success: false,
                    error: { message: '未找到 Key', code: 'KEY_NOT_FOUND' }
                });
                return true;
            }

            // 计算使用百分比
            const usagePercent = keyData.dailyLimit > 0
                ? Math.round((keyData.todayUsage / keyData.dailyLimit) * 100)
                : 0;

            // 返回用户友好的使用量信息（隐藏敏感信息）
            sendJson(res, 200, {
                success: true,
                data: {
                    name: keyData.name,
                    enabled: keyData.enabled,
                    usage: {
                        today: keyData.todayUsage,
                        limit: keyData.dailyLimit,
                        remaining: Math.max(0, keyData.dailyLimit - keyData.todayUsage),
                        percent: usagePercent,
                        resetDate: keyData.lastResetDate,
                        promptTokens: keyData.todayPromptTokens || 0,
                        completionTokens: keyData.todayCompletionTokens || 0,
                        totalTokens: keyData.todayTotalTokens || 0,
                        cachedTokens: keyData.todayCachedTokens || 0,
                        qps: keyData.qps || 0,
                        tps: keyData.tps || 0,
                        rpm: keyData.rpm || 0,
                        maxQps: keyData.maxQps || 0,
                        maxTps: keyData.maxTps || 0,
                        maxRpm: keyData.maxRpm || 0
                    },
                    total: keyData.totalUsage,
                    tokens: {
                        prompt: keyData.totalPromptTokens || 0,
                        completion: keyData.totalCompletionTokens || 0,
                        total: keyData.totalTokens || 0,
                        cached: keyData.totalCachedTokens || 0
                    },
                    lastUsedAt: keyData.lastUsedAt,
                    createdAt: keyData.createdAt,
                    usageHistory: keyData.usageHistory || {},
                    // 显示部分遮蔽的 Key ID

                    maskedKey: `${apiKey.substring(0, 12)}...${apiKey.substring(apiKey.length - 4)}`
                }
            });
            return true;
        }

        // 未匹配的用户端路由
        sendJson(res, 404, {
            success: false,
            error: { message: '未找到用户 API 端点' }
        });
        return true;

    } catch (error) {
        logger.error('[API Potluck] User API error:', error);
        sendJson(res, 500, {
            success: false,
            error: { message: error.message || '内部服务器错误' }
        });
        return true;
    }
}
