import { createAnthropic } from '@ai-sdk/anthropic';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { StreamRequestType } from '@onlook/models/chat';
import { BASE_PROXY_ROUTE, FUNCTIONS_ROUTE, ProxyRoutes } from '@onlook/models/constants';
import { BEDROCK_MODELS, CLAUDE_MODELS, LLMProvider } from '@onlook/models/llm';
import { type LanguageModelV1 } from '@ai-sdk/provider';
import { getRefreshedAuthTokens } from '../auth';
export interface OnlookPayload {
    requestType: StreamRequestType;
}

export async function initModel(
    provider: LLMProvider,
    model: CLAUDE_MODELS | BEDROCK_MODELS,
    payload: OnlookPayload,
): Promise<LanguageModelV1> {
    switch (provider) {
        case LLMProvider.DELAMAIN:
            return await getDelamainProvider();
        case LLMProvider.ANTHROPIC:
            return await getAnthropicProvider(model as CLAUDE_MODELS, payload);
        case LLMProvider.BEDROCK_MODELS:
            return await getBedrockProvider(model as BEDROCK_MODELS);
        default:
            throw new Error(`Unsupported provider: ${provider}`);
    }
}

async function getDelamainProvider(): Promise<LanguageModelV1> {
// model: CLAUDE_MODELS,
// payload: OnlookPayload,
    const config: {
        apiKey?: string;
        baseURL?: string;
        headers?: Record<string, string>;
    } = {};

    config.baseURL = 'http://localhost:9870/anthropic/v1';
    config.apiKey = 'No key';

    const anthropic = createAnthropic(config);
    return anthropic(CLAUDE_MODELS.SONNET, {
        cacheControl: true,
    });
}

async function getBedrockProvider(model: BEDROCK_MODELS): Promise<LanguageModelV1> {
    const region = import.meta.env.VITE_AWS_REGION;
    const accessKeyId = import.meta.env.VITE_AWS_ACCESS_KEY_ID;
    const secretAccessKey = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;
    const sessionToken = import.meta.env.VITE_AWS_SESSION_TOKEN;

    const bedrock = createAmazonBedrock({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
    });

    return bedrock.languageModel(model, {}) as LanguageModelV1;
}

async function getAnthropicProvider(
    model: CLAUDE_MODELS,
    payload: OnlookPayload,
): Promise<LanguageModelV1> {
    const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
    const proxyUrl = `${import.meta.env.VITE_SUPABASE_API_URL}${FUNCTIONS_ROUTE}${BASE_PROXY_ROUTE}${ProxyRoutes.ANTHROPIC}`;

    const config: {
        apiKey?: string;
        baseURL?: string;
        headers?: Record<string, string>;
    } = {};

    if (apiKey) {
        config.apiKey = apiKey;
    } else {
        const authTokens = await getRefreshedAuthTokens();
        if (!authTokens) {
            throw new Error('No auth tokens found');
        }
        config.apiKey = '';
        config.baseURL = proxyUrl;
        config.headers = {
            Authorization: `Bearer ${authTokens.accessToken}`,
            'X-Onlook-Request-Type': payload.requestType,
        };
    }

    const anthropic = createAnthropic(config);
    return anthropic(model, {
        cacheControl: true,
    });
}
