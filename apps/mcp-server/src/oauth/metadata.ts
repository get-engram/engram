// OAuth 2.1 / MCP authorization discovery documents and the resource-server
// challenge. All URLs are derived from the incoming request origin so the same
// code serves mcp.getengram.app, *.workers.dev, and localhost dev unchanged.

/** Scopes Engram understands. v1 grants both; enforcement is future work. */
export const OAUTH_SCOPES = ["engram:read", "engram:write"] as const;
export const DEFAULT_SCOPE = OAUTH_SCOPES.join(" ");

/** Origin of the request, e.g. "https://mcp.getengram.app". */
export function originOf(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

/** Canonical resource identifier for this MCP server (RFC 8707). */
export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

/** URL of the protected-resource metadata document (RFC 9728). */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource`;
}

/**
 * Value for the `WWW-Authenticate` header on a 401 from /mcp, pointing clients
 * at the resource metadata so they can discover the authorization server.
 */
export function wwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`;
}

/** RFC 9728 — OAuth Protected Resource Metadata. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** RFC 8414 — OAuth Authorization Server Metadata. */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: [...OAUTH_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  };
}
