import logger from '../../utils/logger.js';
import { checkAuth } from '../../ui-modules/auth.js';
import { isAuthorized } from '../../utils/common.js';
import { getStats, resetStats, resetTokenStats } from './stats-manager.js';

function sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendResetResult(res, stats, successMessage) {
    const persistencePending = stats?.persistencePending === true;
    sendJson(res, persistencePending ? 202 : 200, {
        success: true,
        persistencePending,
        message: persistencePending
            ? '变更已在内存生效，后台将继续重试持久化；重启服务前请确认统计文件已成功写入。'
            : successMessage,
        data: stats
    });
}

async function checkAdminAuth(req, config) {
    try {
        if (await checkAuth(req)) {
            return true;
        }

        if (config?.REQUIRED_API_KEY) {
            const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            return isAuthorized(req, requestUrl, config.REQUIRED_API_KEY);
        }

        return false;
    } catch (error) {
        logger.error('[Model Usage Stats] Auth check error:', error.message);
        return false;
    }
}

export async function handleModelUsageStatsRoutes(method, path, req, res, config) {
    if (!path.startsWith('/api/model-usage-stats')) {
        return false;
    }

    const isAuthed = await checkAdminAuth(req, config);
    if (!isAuthed) {
        sendJson(res, 401, {
            success: false,
            error: {
                message: '未授权：请提供后台登录 Token 或有效 API Key',
                code: 'UNAUTHORIZED'
            }
        });
        return true;
    }

    try {
        if (method === 'GET' && path === '/api/model-usage-stats') {
            const stats = await getStats();
            sendJson(res, 200, { success: true, data: stats });
            return true;
        }

        if ((method === 'POST' || method === 'DELETE') && path === '/api/model-usage-stats/reset') {
            const stats = await resetStats();
            sendResetResult(res, stats, '模型统计已重置');
            return true;
        }

        if ((method === 'POST' || method === 'DELETE') && path === '/api/model-usage-stats/reset-tokens') {
            const stats = await resetTokenStats();
            sendResetResult(res, stats, '模型 Token 统计已重置');
            return true;
        }
    } catch (error) {
        logger.error('[Model Usage Stats] Route error:', error.message);
        sendJson(res, 500, {
            success: false,
            error: {
                message: error.message
            }
        });
        return true;
    }

    return false;
}
