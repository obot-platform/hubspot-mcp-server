import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';
// Define the engagement types we support
const ENGAGEMENT_TYPES = ['NOTE', 'TASK', 'EMAIL'];
const NoteMetadataSchema = z.object({
    body: z.string().describe('The content of the note'),
});
const TaskMetadataSchema = z.object({
    body: z.string().describe('The body/description of the task'),
    subject: z.string().describe('The title/subject of the task'),
    status: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'WAITING']).default('NOT_STARTED'),
    forObjectType: z.enum(['CONTACT', 'COMPANY', 'DEAL', 'TICKET']).default('CONTACT'),
});
const RECIPIENT_SOFT_CAP = 25;
const RECIPIENT_HARD_CAP = 200;
const EmailMetadataSchema = z
    .object({
    subject: z.string().min(1).describe('The subject line of the email'),
    text: z.string().optional().describe('Plaintext email body'),
    html: z.string().optional().describe('HTML email body'),
    from: z.string().email().optional().describe('Sender email address'),
    to: z.array(z.string().email()).min(1).max(RECIPIENT_HARD_CAP).describe('Recipient email addresses'),
    cc: z.array(z.string().email()).max(RECIPIENT_HARD_CAP).optional().describe('CC recipient email addresses'),
    bcc: z.array(z.string().email()).max(RECIPIENT_HARD_CAP).optional().describe('BCC recipient email addresses'),
    replyTo: z.array(z.string().email()).max(RECIPIENT_HARD_CAP).optional().describe('Reply-to email addresses'),
})
    .superRefine((data, ctx) => {
    if (!data.text && !data.html) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Either text or html is required for EMAIL engagements',
            path: ['text'],
        });
    }
});
export const AssociationsSchema = z.object({
    contactIds: z.array(z.number().int()).max(100).optional().default([]),
    companyIds: z.array(z.number().int()).max(100).optional().default([]),
    dealIds: z.array(z.number().int()).max(100).optional().default([]),
    ownerIds: z.array(z.number().int()).max(100).optional().default([]),
    ticketIds: z.array(z.number().int()).max(100).optional().default([]),
});
// Map engagement types to their metadata schemas
const metadataSchemas = {
    NOTE: NoteMetadataSchema,
    TASK: TaskMetadataSchema,
    EMAIL: EmailMetadataSchema,
};
const CreateEngagementSchema = z
    .object({
    type: z.enum(ENGAGEMENT_TYPES).describe('The type of engagement to create (NOTE, TASK, or EMAIL)'),
    ownerId: z.number().int().positive().describe('The ID of the owner of this engagement'),
    timestamp: z
        .number()
        .int()
        .optional()
        .describe('Timestamp for the engagement (milliseconds since epoch). Defaults to current time if not provided.'),
    associations: AssociationsSchema.describe('Associated records for this engagement'),
    metadata: z.object({}).passthrough().describe('Metadata specific to the engagement type'),
})
    .superRefine((data, ctx) => {
    const schema = metadataSchemas[data.type];
    if (!schema) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Unsupported engagement type: ${data.type}`,
            path: ['type'],
        });
        return;
    }
    const result = schema.safeParse(data.metadata);
    if (!result.success) {
        result.error.issues.forEach(issue => {
            ctx.addIssue({
                ...issue,
                path: ['metadata', ...(issue.path || [])],
            });
        });
    }
});
const ToolDefinition = {
    name: 'hubspot-create-engagement',
    description: `
    🛡️ Guardrails:
      1. Data Modification Warning: This tool modifies HubSpot data. Only use when the user has explicitly requested to update their CRM.

    🎯 Purpose:
      1. Creates a HubSpot engagement (Note, Task, or Email) associated with contacts, companies, deals, or tickets.
      2. This endpoint is useful for keeping your CRM records up-to-date on any interactions that take place outside of HubSpot.
      3. Activity reporting in the CRM also feeds off of this data.

    📋 Prerequisites:
      1. Use the hubspot-get-user-details tool to get the OwnerId and UserId.

    🧭 Usage Guidance:
      1. Use NOTE type for adding notes to records
      2. Use TASK type for creating tasks with subject, status, and assignment
      3. Both require relevant associations to connect them to CRM records
      4. For EMAIL: Prefer using hubspot-send-templated-email instead - it supports template lookup and creates the engagement automatically.
      5. Use EMAIL type here only for advanced use cases (e.g., recording externally-sent emails in CRM history).
      6. Other types of engagements (CALL, MEETING) are NOT supported yet.
      7. HubSpot notes and task descriptions support HTML formatting. However headings (<h1>, <h2>, etc.) look ugly in the CRM. So use them sparingly.
  `,
    inputSchema: zodToJsonSchema(CreateEngagementSchema),
    annotations: {
        title: 'Create Engagement',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
};
export class CreateEngagementTool extends BaseTool {
    client;
    associationTypeCache = new Map();
    constructor() {
        super(CreateEngagementSchema, ToolDefinition);
        this.client = new HubSpotClient();
    }
    collectRecipientWarnings(metadata) {
        const warnings = [];
        const fields = [
            { name: 'to', value: metadata.to },
            { name: 'cc', value: metadata.cc },
            { name: 'bcc', value: metadata.bcc },
            { name: 'replyTo', value: metadata.replyTo },
        ];
        for (const field of fields) {
            if (field.value && field.value.length > RECIPIENT_SOFT_CAP) {
                warnings.push(`Warning: large recipient list: ${field.name} has ${field.value.length} addresses.`);
            }
        }
        return warnings;
    }
    async getAssociationTypeId(fromObjectType, toObjectType) {
        const cacheKey = `${fromObjectType}:${toObjectType}`;
        if (this.associationTypeCache.has(cacheKey)) {
            return this.associationTypeCache.get(cacheKey);
        }
        const response = await this.client.get(`/crm/v4/associations/${fromObjectType}/${toObjectType}/labels`);
        const match = response?.results?.find(item => item.category === 'HUBSPOT_DEFINED') || response?.results?.[0];
        const typeId = match?.typeId ?? match?.associationTypeId ?? match?.id;
        if (!typeId) {
            throw new Error(`No association type found for ${fromObjectType} -> ${toObjectType}`);
        }
        this.associationTypeCache.set(cacheKey, typeId);
        return typeId;
    }
    buildEmailHeaders(metadata) {
        const headers = {
            from: metadata.from ? { email: metadata.from } : undefined,
            sender: metadata.from ? { email: metadata.from } : undefined,
            to: metadata.to.map(email => ({ email })),
            cc: metadata.cc ? metadata.cc.map(email => ({ email })) : undefined,
            bcc: metadata.bcc ? metadata.bcc.map(email => ({ email })) : undefined,
            replyTo: metadata.replyTo ? metadata.replyTo.map(email => ({ email })) : undefined,
        };
        return Object.fromEntries(Object.entries(headers).filter(([_, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)));
    }
    async buildEmailAssociations(associations) {
        const associationsPayload = [];
        if (associations?.contactIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'contacts');
            associations.contactIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        if (associations?.companyIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'companies');
            associations.companyIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        if (associations?.dealIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'deals');
            associations.dealIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        if (associations?.ticketIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'tickets');
            associations.ticketIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        return associationsPayload;
    }
    async createEmailEngagement(args) {
        const { ownerId, timestamp, associations, metadata } = args;
        const warnings = this.collectRecipientWarnings(metadata);
        const emailTimestamp = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();
        const headers = this.buildEmailHeaders(metadata);
        const properties = Object.fromEntries(Object.entries({
            hs_timestamp: emailTimestamp,
            hubspot_owner_id: String(ownerId),
            hs_email_direction: 'EMAIL',
            hs_email_status: 'SENT',
            hs_email_subject: metadata.subject,
            hs_email_text: metadata.text,
            hs_email_html: metadata.html,
            hs_email_headers: JSON.stringify(headers),
        }).filter(([_, value]) => value !== undefined));
        const associationsPayload = await this.buildEmailAssociations(associations);
        const requestBody = Object.fromEntries(Object.entries({
            properties,
            associations: associationsPayload.length > 0 ? associationsPayload : undefined,
        }).filter(([_, value]) => value !== undefined));
        const response = await this.client.post('/crm/v3/objects/emails', {
            body: requestBody,
        });
        const result = {
            status: 'success',
            email: response,
            message: 'Successfully created email engagement',
        };
        if (warnings.length > 0) {
            result.warnings = warnings;
        }
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
    async process(args) {
        try {
            if (args.type === 'EMAIL') {
                return await this.createEmailEngagement(args);
            }
            const { type, ownerId, timestamp, associations, metadata } = args;
            const engagementTimestamp = timestamp || Date.now();
            const requestBody = {
                engagement: {
                    active: true,
                    ownerId,
                    type,
                    timestamp: engagementTimestamp,
                },
                associations,
                metadata,
            };
            const response = await this.client.post('/engagements/v1/engagements', {
                body: requestBody,
            });
            const result = {
                status: 'success',
                engagement: response,
                message: `Successfully created ${type.toLowerCase()} engagement`,
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
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error creating HubSpot engagement: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
