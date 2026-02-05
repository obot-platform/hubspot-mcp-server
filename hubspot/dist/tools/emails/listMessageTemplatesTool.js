import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';

const ListMessageTemplatesSchema = z.object({
    searchTerm: z.string().min(1).optional().describe('Template name or subject to search for (optional)') ,
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Results per page to fetch from HubSpot (max 500)'),
    after: z.string().optional().describe('Paging cursor for the first page'),
    maxPages: z
        .number()
        .int()
        .min(1)
        .max(10)
        .default(3)
        .describe('Maximum number of pages to scan for matches'),
});

const ToolDefinition = {
    name: 'hubspot-list-message-templates',
    description: `
    🎯 Purpose:
      1. Lists HubSpot CRM Message Templates (Sales/Service templates).
      2. Supports optional fuzzy search by name or subject.

    📦 Returns:
      1. Ranked list of matching message templates with id values.

    🧭 Usage Guidance:
      1. Use this to find CRM Message Templates shown under CRM → Message templates.
      2. This is NOT the same as Marketing Email templates (use hubspot-list-email-templates for those).
  `,
    inputSchema: zodToJsonSchema(ListMessageTemplatesSchema),
    annotations: {
        title: 'List Message Templates',
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
        return { score: 0, field: 'name', match: name || subject || '' };
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

const extractName = item => item?.properties?.name
    || item?.properties?.hs_name
    || item?.properties?.template_name
    || item?.name;

const extractSubject = item => item?.properties?.subject
    || item?.properties?.hs_subject
    || item?.properties?.email_subject
    || item?.subject;

export class ListMessageTemplatesTool extends BaseTool {
    client;
    constructor() {
        super(ListMessageTemplatesSchema, ToolDefinition);
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
                queryParams.append('archived', 'false');
                if (after) {
                    queryParams.append('after', after);
                }
                queryParams.append('properties', 'name');
                queryParams.append('properties', 'subject');
                queryParams.append('properties', 'hs_name');
                queryParams.append('properties', 'hs_subject');
                queryParams.append('properties', 'template_name');
                queryParams.append('properties', 'email_subject');
                const response = await this.client.get(`/crm/v3/objects/communication_templates?${queryParams.toString()}`);
                if (response?.results && Array.isArray(response.results)) {
                    allResults.push(...response.results);
                }
                pagesFetched += 1;
                after = response?.paging?.next?.after;
                if (!after) {
                    break;
                }
            }
            const MAX_RETURNED_MATCHES = 25;
            const matches = allResults
                .map(item => {
                const name = extractName(item);
                const subject = extractSubject(item);
                const matchInfo = scoreMatch(term, name, subject);
                if (!matchInfo) {
                    return null;
                }
                return {
                    id: item?.id,
                    name,
                    subject,
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
                searchTerm: args.searchTerm ?? null,
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
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error searching HubSpot message templates: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
