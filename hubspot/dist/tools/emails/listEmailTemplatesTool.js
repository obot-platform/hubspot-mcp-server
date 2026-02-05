import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';

const ListEmailTemplatesSchema = z.object({
    searchTerm: z.string().min(1).describe('Template name or subject to search for'),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(100)
        .describe('Results per page to fetch from HubSpot (max 100)'),
    after: z.string().optional().describe('Paging cursor for the first page'),
    types: z
        .array(z.string())
        .optional()
        .describe('Optional email types to filter by (e.g., SINGLE_SEND_API, SMTP_TOKEN)'),
    maxPages: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe('Maximum number of pages to scan for matches'),
});

const ToolDefinition = {
    name: 'hubspot-list-email-templates',
    description: `
    🎯 Purpose:
      1. Lists HubSpot Marketing Email templates by name or subject with ranked matches.
      2. Uses fuzzy matching to find templates even with partial matches.

    📦 Returns:
      1. Ranked list of matching templates with their id values.

    🧭 Usage Guidance:
      1. Use this to find a template ID before using hubspot-send-templated-email.
      2. Requires the 'content' scope on the HubSpot access token.
      3. If you get a scope error, use hubspot-send-templated-email with direct content instead.
  `,
    inputSchema: zodToJsonSchema(ListEmailTemplatesSchema),
    annotations: {
        title: 'List Email Templates',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
};

const normalize = value => (value ?? '').toString().trim().toLowerCase();

const scoreMatch = (term, name, subject) => {
    const nameNorm = normalize(name);
    const subjectNorm = normalize(subject);
    if (!term) {
        return null;
    }
    if (nameNorm === term) {
        return { score: 0, field: 'name', match: name };
    }
    if (subjectNorm === term) {
        return { score: 1, field: 'subject', match: subject };
    }
    if (nameNorm.startsWith(term)) {
        return { score: 2, field: 'name', match: name };
    }
    if (subjectNorm.startsWith(term)) {
        return { score: 3, field: 'subject', match: subject };
    }
    if (nameNorm.includes(term)) {
        return { score: 4, field: 'name', match: name };
    }
    if (subjectNorm.includes(term)) {
        return { score: 5, field: 'subject', match: subject };
    }
    return null;
};

export class ListEmailTemplatesTool extends BaseTool {
    client;
    constructor() {
        super(ListEmailTemplatesSchema, ToolDefinition);
        this.client = new HubSpotClient();
    }
    async process(args) {
        try {
            const term = normalize(args.searchTerm);
            let after = args.after;
            let pagesFetched = 0;
            const allResults = [];
            while (pagesFetched < args.maxPages) {
                const queryParams = new URLSearchParams();
                queryParams.append('limit', args.limit.toString());
                if (after) {
                    queryParams.append('after', after);
                }
                if (args.types && args.types.length > 0) {
                    args.types.forEach(type => queryParams.append('type', type));
                }
                const response = await this.client.get(`/marketing/v3/emails/?${queryParams.toString()}`);
                if (response?.results && Array.isArray(response.results)) {
                    allResults.push(...response.results);
                }
                pagesFetched += 1;
                after = response?.paging?.next?.after || response?.paging?.next?.pageToken || response?.nextPageToken;
                if (!after) {
                    break;
                }
            }
            const MAX_RETURNED_MATCHES = 25;
            const matches = allResults
                .map(item => {
                const matchInfo = scoreMatch(term, item?.name, item?.subject);
                if (!matchInfo) {
                    return null;
                }
                return {
                    id: item?.id,
                    name: item?.name,
                    subject: item?.subject,
                    type: item?.type,
                    updatedAt: item?.updatedAt,
                    score: matchInfo.score,
                    matchField: matchInfo.field,
                    matchValue: matchInfo.match,
                };
            })
                .filter(Boolean)
                .sort((a, b) => {
                if (a.score !== b.score) {
                    return a.score - b.score;
                }
                return normalize(a.name).localeCompare(normalize(b.name));
            })
                .slice(0, MAX_RETURNED_MATCHES);
            const resultData = {
                searchTerm: args.searchTerm,
                pagesFetched,
                totalScanned: allResults.length,
                matches,
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(resultData, null, 2),
                    },
                ],
                structuredContent: resultData,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Check for scope/permission errors and provide actionable guidance
            if (errorMessage.includes('403') || 
                errorMessage.toLowerCase().includes('scope') || 
                errorMessage.toLowerCase().includes('forbidden') ||
                errorMessage.toLowerCase().includes('permission')) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: 'MISSING_SCOPE',
                                requiredScope: 'content',
                                message: 'The HubSpot access token is missing the "content" scope required to list email templates.',
                                guidance: [
                                    'Option 1: Ask the admin to add the "content" scope to the HubSpot private app.',
                                    'Option 2: Use hubspot-send-templated-email with the "content" parameter instead of "templateId" - this works without the content scope.',
                                ],
                                originalError: errorMessage,
                            }, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error searching HubSpot email templates: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
