import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';

const ListEmailEventsSchema = z.object({
    recipient: z.string().email().optional().describe('Recipient email address to query events for'),
    contactId: z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])
        .optional()
        .describe('Contact ID. If provided, the tool will look up the email address first.'),
    eventType: z.string().optional().describe('Optional event type filter (e.g., SENT, OPEN, CLICK, BOUNCE)') ,
    count: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe('Number of events to return (max 1000)'),
    offset: z.number().int().min(0).optional().describe('Offset for pagination'),
}).refine(data => data.recipient || data.contactId, {
    message: 'Provide either recipient or contactId',
});

const ToolDefinition = {
    name: 'hubspot-list-email-events',
    description: `
    🎯 Purpose:
      1. Lists marketing/transactional email events for a recipient.
      2. Useful for confirming sends, opens, clicks, and bounces.

    📋 Prerequisites:
      1. Requires marketing-email or transactional-email scope.
      2. If using contactId, the contact must have an email property set.

    🧭 Usage Guidance:
      1. Provide recipient (email) or contactId.
      2. Use eventType to filter (SENT, OPEN, CLICK, BOUNCE, DELIVERED, etc.).
      3. The result is derived from HubSpot Email Events API, not CRM email objects.
  `,
    inputSchema: zodToJsonSchema(ListEmailEventsSchema),
    annotations: {
        title: 'List Email Events',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
    },
};

export class ListEmailEventsTool extends BaseTool {
    client;
    constructor() {
        super(ListEmailEventsSchema, ToolDefinition);
        this.client = new HubSpotClient();
    }

    async resolveRecipient(contactId) {
        const response = await this.client.get(`/crm/v3/objects/contacts/${contactId}`, {
            params: { properties: 'email' },
        });
        const email = response?.properties?.email;
        if (!email) {
            throw new Error(`Contact ${contactId} has no email property.`);
        }
        return email;
    }

    async process(args) {
        try {
            const recipient = args.recipient || (args.contactId ? await this.resolveRecipient(args.contactId) : null);
            const params = {
                recipient,
                count: args.count,
            };
            if (args.offset !== undefined) {
                params.offset = args.offset;
            }
            if (args.eventType) {
                params.eventType = args.eventType;
            }
            const response = await this.client.get('/email/public/v1/events', { params });
            const result = {
                recipient,
                count: args.count,
                offset: response?.offset ?? args.offset ?? 0,
                hasMore: Boolean(response?.hasMore),
                events: response?.events ?? response?.results ?? [],
            };
            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(result, null, 2),
                    },
                ],
                structuredContent: result,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (errorMessage.includes('403') ||
                errorMessage.toLowerCase().includes('scope') ||
                errorMessage.toLowerCase().includes('forbidden')) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                error: 'MISSING_SCOPE',
                                requiredScope: 'marketing-email or transactional-email',
                                message: 'The HubSpot access token is missing the required scope to read email events.',
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
                        text: `Error listing email events: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
