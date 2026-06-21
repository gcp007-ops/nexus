/**
 * src/services/external/GeminiCliAuthService.ts
 *
 * Auth/status checker for the legacy google-gemini-cli provider.
 *
 * The provider id is retained for settings compatibility, but the runtime is
 * Google Antigravity CLI (`agy`). The deprecated `gemini` binary is not used.
 */
import { App, Platform } from 'obsidian';
import {
    ANTIGRAVITY_CLI_LOCAL_AUTH_SENTINEL,
    ensureAntigravityMcpConfig,
    hasReadableAntigravityAuthToken,
    resolveAntigravityCliRuntime
} from '../../utils/antigravityCli';

export interface GeminiCliAuthStatus {
    available: boolean;
    loggedIn: boolean;
    authMethod: string;
    agyPath: string | null;
    error?: string;
}

export class GeminiCliAuthService {
    constructor(private app: App) {}

    /**
     * Check whether the Gemini CLI is installed and authenticated.
     */
    async getStatus(): Promise<GeminiCliAuthStatus> {
        if (!Platform.isDesktop) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                agyPath: null,
                error: 'Antigravity CLI is only available on desktop.'
            };
        }

        const runtime = resolveAntigravityCliRuntime(this.app.vault);
        if (!runtime.agyPath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                agyPath: null,
                error: 'Antigravity CLI (`agy`) was not found on PATH. Install and sign in to AGY, then try again.'
            };
        }

        if (!runtime.nodePath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                agyPath: runtime.agyPath,
                error: 'Node.js was not found on PATH. Node is required for the Nexus MCP connector.'
            };
        }

        if (!runtime.connectorPath) {
            return {
                available: false,
                loggedIn: false,
                authMethod: 'none',
                agyPath: runtime.agyPath,
                error: 'Nexus connector.js was not found for this vault. Recreate the Nexus connector before using Antigravity CLI.'
            };
        }

        const loggedIn = hasReadableAntigravityAuthToken(runtime.authTokenPath);
        return {
            available: true,
            loggedIn,
            authMethod: loggedIn ? 'agy-oauth' : 'unknown',
            agyPath: runtime.agyPath,
            error: loggedIn
                ? undefined
                : 'Antigravity CLI is not authenticated. Run `agy` in your terminal and complete login first.'
        };
    }

    /**
     * Check if the CLI is authenticated. If yes, return the sentinel key.
     * If not, return a clear error directing the user to authenticate externally.
     *
     * This is used as the "connect" flow — it's check-only, no terminal launch.
     */
    async checkAuth(): Promise<{ success: boolean; apiKey?: string; metadata?: Record<string, string>; error?: string }> {
        const status = await this.getStatus();

        if (!status.available) {
            return { success: false, error: status.error };
        }

        if (!status.loggedIn) {
            return { success: false, error: status.error };
        }

        const runtime = resolveAntigravityCliRuntime(this.app.vault);
        try {
            await ensureAntigravityMcpConfig(runtime);
        } catch (error) {
            return { success: false, error: (error as Error).message };
        }

        return {
            success: true,
            apiKey: ANTIGRAVITY_CLI_LOCAL_AUTH_SENTINEL,
            metadata: {
                authMethod: 'agy-oauth',
                runtime: 'agy',
                agyPath: status.agyPath || ''
            }
        };
    }
}
