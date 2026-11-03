import { validateMixedSend, hasMixedNativeAttempts, MIXED_KEY } from '../../services/gpt-mixed-routing.js';
import requestContext from '../../utils/context.js';
import { beginRequestAttempt, finishRequestAttempt } from '../../utils/request-attempts.js';
import axios from 'axios';
import logger from '../../utils/logger.js';
import * as http from 'http';
import * as https from 'https';
import { configureAxiosProxy, configureTLSSidecar, isTLSSidecarEnabledForProvider } from '../../utils/proxy-utils.js';
import { MODEL_PROVIDER, getRetryAfterMs, captureSafeUpstreamErrorDiagnostic } from '../../utils/common.js';

// OpenAI Responses API specification service for interacting with third-party models
export class OpenAIResponsesApiService {
    constructor(config) {
        if (!config.OPENAI_API_KEY) {
            throw new Error("OpenAI API Key is required for OpenAIResponsesApiService.");
        }
        this.config = config;
        this.apiKey = config.OPENAI_API_KEY;
        this.baseUrl = config.OPENAI_BASE_URL || 'https://api.openai.com/v1';
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_OPENAI ?? false;
        logger.info(`[OpenAIResponses] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        
        const axiosConfig = {
            baseURL: this.baseUrl,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            }
        };

        this.axiosInstance = axios.create(axiosConfig);

    }

    _applySidecar(axiosConfig) {
        return configureTLSSidecar(axiosConfig, this.config, this.config.MODEL_PROVIDER || MODEL_PROVIDER.OPENAI_CUSTOM_RESPONSES, this.baseUrl);
    }

    async _beginMixedAttempt(body, stream) {
        await validateMixedSend(MIXED_KEY, this.config.uuid);
        if (!hasMixedNativeAttempts(MIXED_KEY)) return null;
        const state = requestContext.get('gptMixedState');
        body.model = state.selection.model;
        return beginRequestAttempt(body, { providerType: MIXED_KEY, providerUuid: this.config.uuid,
            plannedModel: state.selection.model, outboundModel: body.model, stream });
    }

    async callApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        const attempt = await this._beginMixedAttempt(body, false);
        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: body
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            finishRequestAttempt(attempt, { status: 'success', httpStatus: response.status,
                upstreamResponseModel: response.data?.model || null });
            return response.data;
        } catch (error) {
            const diagnostic = attempt ? await captureSafeUpstreamErrorDiagnostic(error) : null;
            finishRequestAttempt(attempt, { status: 'error', httpStatus: error.response?.status || null,
                errorCode: diagnostic?.code || error.response?.data?.error?.code || error.code || null });
            const status = error.response?.status;
            const data = error.response?.data;
            if (['insufficient_quota', 'credit_balance_exhausted'].includes(diagnostic?.code || data?.error?.code)) throw error;
            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status}. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[API] Received 429 with Retry-After: ${retryAfter}ms. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[API] Received 429 (Too Many Requests). No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return this.callApi(endpoint, body, isRetry, retryCount + 1);
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[API] Received ${status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(endpoint, body, isRetry, retryCount + 1);
            }

            logger.error(`Error calling OpenAI Responses API (Status: ${status}):`, error.message);
            throw error;
        }
    }

    async *streamApi(endpoint, body, isRetry = false, retryCount = 0) {
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000;  // 1 second base delay

        // OpenAI 的流式请求需要将 stream 设置为 true
        const attempt = await this._beginMixedAttempt(body, true);
        const streamRequestBody = { ...body, stream: true };
        let outputStarted = false;
        let completed = false;

        try {
            const axiosConfig = {
                method: 'post',
                url: endpoint,
                data: streamRequestBody,
                responseType: 'stream'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);

            const stream = response.data;
            let buffer = '';

            for await (const chunk of stream) {
                buffer += chunk.toString();
                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex).trim();
                    buffer = buffer.substring(newlineIndex + 1);

                    if (line.startsWith('data: ')) {
                        const jsonData = line.substring(6).trim();
                        if (jsonData === '[DONE]') {
                            finishRequestAttempt(attempt, { status: completed ? 'success' : 'error', httpStatus: 200,
                                ...(!completed ? { errorCode: 'INCOMPLETE_UPSTREAM_STREAM' } : {}) });
                            return; // Stream finished
                        }
                        try {
                            const parsedChunk = JSON.parse(jsonData);
                            outputStarted = true;
                            if (parsedChunk.type === 'response.completed') completed = true;
                            yield parsedChunk;
                        } catch (e) {
                            logger.warn("[OpenAIResponsesApiService] Failed to parse stream chunk JSON:", e.message, "Data:", jsonData);
                        }
                    } else if (line === '') {
                        // Empty line, end of an event
                    }
                }
            }
            finishRequestAttempt(attempt, { status: completed ? 'success' : 'error', httpStatus: 200,
                ...(!completed ? { errorCode: 'INCOMPLETE_UPSTREAM_STREAM' } : {}) });
        } catch (error) {
            const diagnostic = attempt ? await captureSafeUpstreamErrorDiagnostic(error) : null;
            finishRequestAttempt(attempt, { status: 'error', httpStatus: error.response?.status || null,
                errorCode: diagnostic?.code || error.response?.data?.error?.code || error.code || null });
            if (attempt && outputStarted) throw error;
            const status = error.response?.status;
            const data = error.response?.data;
            if (['insufficient_quota', 'credit_balance_exhausted'].includes(diagnostic?.code || data?.error?.code)) throw error;
            if (status === 401 || status === 403) {
                logger.error(`[API] Received ${status} during stream. API Key might be invalid or expired.`);
                throw error;
            }

            // Handle 429 (Too Many Requests)
            if (status === 429) {
                const retryAfter = getRetryAfterMs(error);
                if (retryAfter !== null) {
                    logger.warn(`[API] Received 429 with Retry-After: ${retryAfter}ms during stream. Throwing to upper layer.`);
                    throw error;
                }
                if (retryCount < maxRetries) {
                    const delay = baseDelay * Math.pow(2, retryCount);
                    logger.info(`[API] Received 429 (Too Many Requests) during stream. No Retry-After found. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                    return;
                }
            }

            // Handle other retryable errors (5xx server errors)
            if (status >= 500 && status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                logger.info(`[API] Received ${status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                yield* this.streamApi(endpoint, body, isRetry, retryCount + 1);
                return;
            }

            logger.error(`Error calling OpenAI Responses streaming API (Status: ${status}):`, error.message);
            throw error;
        } finally {
            if (attempt?.status === 'started') {
                finishRequestAttempt(attempt, { status: completed ? 'success' : 'error',
                    httpStatus: outputStarted ? 200 : null,
                    ...(!completed ? { errorCode: 'UPSTREAM_STREAM_INTERRUPTED' } : {}) });
            }
        }
    }

    async generateContent(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        return this.callApi('/responses', requestBody);
    }

    async *generateContentStream(model, requestBody) {
        // 临时存储 monitorRequestId
        if (requestBody._monitorRequestId) {
            this.config._monitorRequestId = requestBody._monitorRequestId;
            delete requestBody._monitorRequestId;
        }
        if (requestBody._requestBaseUrl) {
            delete requestBody._requestBaseUrl;
        }

        yield* this.streamApi('/responses', requestBody);
    }

    async listModels() {
        try {
            const axiosConfig = {
                method: 'get',
                url: '/models'
            };
            this._applySidecar(axiosConfig);
            const response = await this.axiosInstance.request(axiosConfig);
            return response.data;
        } catch (error) {
            const status = error.response?.status;
            const data = error.response?.data;
            logger.error(`Error listing OpenAI Responses models (Status: ${status}):`, data || error.message);
            throw error;
        }
    }
}
