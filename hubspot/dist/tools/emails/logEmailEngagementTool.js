import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';

const RECIPIENT_SOFT_CAP = 25;
const RECIPIENT_HARD_CAP = 200;

const EmailContentSchema = z.object({
    subject: z.string().min(1).describe('Email subject line'),
    html: z.string().optional().describe('HTML email body'),
    text: z.string().optional().describe('Plain text email body'),
}).refine(data => data.html || data.text, {
    message: 'Either html or text body is required',
});

// Helper to coerce string to number for IDs
const coerceToInt = z.union([
    z.number().int(),
    z.string().regex(/^\d+$/).transform(Number)
]);

const LogEmailEngagementSchema = z.object({
    // Mutually exclusive: templateId OR content
    templateId: z
        .union([z.number().int().positive(), z.string().regex(/^\d+$/).transform(Number)])
        .optional()
        .describe('Marketing Email template ID from hubspot-list-email-templates. Requires "content" scope.'),
    content: EmailContentSchema
        .optional()
        .describe('Direct email content. Use this when you do not have a templateId or lack the "content" scope.'),
    
    // Required fields
    to: z
        .array(z.string().email())
        .min(1)
        .max(RECIPIENT_HARD_CAP)
        .describe('Recipient email addresses'),
    ownerId: coerceToInt
        .describe('HubSpot owner ID for the email engagement. Get this from hubspot-get-user-details.'),
    
    // Optional email headers
    from: z
        .string()
        .email()
        .optional()
        .describe('Sender email address'),
    cc: z
        .array(z.string().email())
        .max(RECIPIENT_HARD_CAP)
        .optional()
        .describe('CC recipient email addresses'),
    bcc: z
        .array(z.string().email())
        .max(RECIPIENT_HARD_CAP)
        .optional()
        .describe('BCC recipient email addresses'),
    
    // CRM associations
    contactIds: z
        .array(coerceToInt)
        .max(100)
        .optional()
        .describe('Contact IDs to associate with this email'),
    companyIds: z
        .array(coerceToInt)
        .max(100)
        .optional()
        .describe('Company IDs to associate with this email'),
    dealIds: z
        .array(coerceToInt)
        .max(100)
        .optional()
        .describe('Deal IDs to associate with this email'),
    ticketIds: z
        .array(coerceToInt)
        .max(100)
        .optional()
        .describe('Ticket IDs to associate with this email'),
}).refine(data => data.templateId !== undefined || data.content !== undefined, {
    message: 'Either templateId or content is required',
}).refine(data => !(data.templateId !== undefined && data.content !== undefined), {
    message: 'Provide either templateId OR content, not both',
});

const ToolDefinition = {
    name: 'hubspot-log-email-engagement',
    description: `
    🛡️ Guardrails:
      1. Data Modification Warning: This tool creates a CRM email engagement record.
      2. Only use when the user has explicitly requested to log an email.

    🎯 Purpose:
      Creates a CRM email engagement record that appears in contact/company activity timelines.
      
    ⚠️ IMPORTANT: This tool does NOT send an actual email.
      It only creates a record in HubSpot CRM to track email communication.
      To actually send emails via API, use hubspot-send-marketing-email (requires Marketing Hub Enterprise).

    📋 Use Cases:
      1. Logging emails sent through external systems (Gmail, Outlook, etc.)
      2. Recording manual email outreach in CRM
      3. Tracking email communication history with contacts/companies

    📋 Prerequisites:
      1. Use hubspot-get-user-details to get the ownerId.
      2. If using templateId, use hubspot-list-email-templates to find the template ID.

    🧭 Usage Guidance:
      1. Prefer templateId when you want to reference an existing HubSpot template.
      2. Use content when you need to log custom email content.
      3. The email record is visible in CRM activity history and associated with contacts/companies/deals/tickets.
      4. Templates may contain HubL variables like {{contact.firstname}} - these are stored but not rendered.
  `,
    inputSchema: zodToJsonSchema(LogEmailEngagementSchema),
    annotations: {
        title: 'Log Email Engagement',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
    },
};

export class LogEmailEngagementTool extends BaseTool {
    client;
    associationTypeCache = new Map();
    
    constructor() {
        super(LogEmailEngagementSchema, ToolDefinition);
        this.client = new HubSpotClient();
    }
    
    collectRecipientWarnings(args) {
        const warnings = [];
        const fields = [
            { name: 'to', value: args.to },
            { name: 'cc', value: args.cc },
            { name: 'bcc', value: args.bcc },
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
    
    buildEmailHeaders(args) {
        const headers = {
            from: args.from ? { email: args.from } : undefined,
            sender: args.from ? { email: args.from } : undefined,
            to: args.to.map(email => ({ email })),
            cc: args.cc ? args.cc.map(email => ({ email })) : undefined,
            bcc: args.bcc ? args.bcc.map(email => ({ email })) : undefined,
        };
        return Object.fromEntries(
            Object.entries(headers).filter(([_, value]) => 
                value !== undefined && (!Array.isArray(value) || value.length > 0)
            )
        );
    }
    
    async buildEmailAssociations(args) {
        const associationsPayload = [];
        
        if (args.contactIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'contacts');
            args.contactIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        
        if (args.companyIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'companies');
            args.companyIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        
        if (args.dealIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'deals');
            args.dealIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        
        if (args.ticketIds?.length) {
            const typeId = await this.getAssociationTypeId('emails', 'tickets');
            args.ticketIds.forEach(id => {
                associationsPayload.push({
                    to: { id: String(id) },
                    types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }],
                });
            });
        }
        
        return associationsPayload;
    }
    
    async fetchTemplateContent(templateId) {
        try {
            const response = await this.client.get(`/marketing/v3/emails/${templateId}`);
            
            if (!response) {
                throw new Error(`Template ${templateId} not found`);
            }
            
            return {
                subject: response.subject || response.name || 'No Subject',
                html: response.content || response.htmlContent || response.body,
                text: response.textContent || response.plainTextVersion,
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Check for scope/permission errors
            if (errorMessage.includes('403') || 
                errorMessage.toLowerCase().includes('scope') || 
                errorMessage.toLowerCase().includes('forbidden') ||
                errorMessage.toLowerCase().includes('permission')) {
                throw new Error(JSON.stringify({
                    error: 'MISSING_SCOPE',
                    requiredScope: 'content',
                    message: 'The HubSpot access token is missing the "content" scope required to fetch email templates.',
                    guidance: [
                        'Option 1: Ask the admin to add the "content" scope to the HubSpot private app.',
                        'Option 2: Call this tool again with the "content" parameter instead of "templateId" - provide subject, html, and/or text directly.',
                    ],
                    originalError: errorMessage,
                }));
            }
            
            // Check for not found
            if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
                throw new Error(JSON.stringify({
                    error: 'TEMPLATE_NOT_FOUND',
                    templateId,
                    message: `Template with ID ${templateId} was not found.`,
                    guidance: [
                        'Use hubspot-list-email-templates to search for available templates.',
                        'Verify the template ID is correct.',
                        'Or use the "content" parameter to provide email content directly.',
                    ],
                    originalError: errorMessage,
                }));
            }
            
            throw error;
        }
    }
    
    async process(args) {
        try {
            const warnings = this.collectRecipientWarnings(args);
            
            // Resolve email content - either from template or direct content
            let emailContent;
            let templateInfo = null;
            
            if (args.templateId !== undefined) {
                templateInfo = { templateId: args.templateId };
                emailContent = await this.fetchTemplateContent(args.templateId);
            } else {
                emailContent = args.content;
            }
            
            // Build email headers
            const headers = this.buildEmailHeaders(args);
            
            // Build properties for CRM email object
            const emailTimestamp = new Date().toISOString();
            const properties = Object.fromEntries(
                Object.entries({
                    hs_timestamp: emailTimestamp,
                    hubspot_owner_id: String(args.ownerId),
                    hs_email_direction: 'EMAIL',
                    hs_email_status: 'SENT',
                    hs_email_subject: emailContent.subject,
                    hs_email_text: emailContent.text,
                    hs_email_html: emailContent.html,
                    hs_email_headers: JSON.stringify(headers),
                }).filter(([_, value]) => value !== undefined)
            );
            
            // Build associations
            const associationsPayload = await this.buildEmailAssociations(args);
            
            // Create the request body
            const requestBody = Object.fromEntries(
                Object.entries({
                    properties,
                    associations: associationsPayload.length > 0 ? associationsPayload : undefined,
                }).filter(([_, value]) => value !== undefined)
            );
            
            // Create CRM email engagement
            const response = await this.client.post('/crm/v3/objects/emails', {
                body: requestBody,
            });
            
            const result = {
                status: 'success',
                message: 'Email engagement logged successfully in CRM (note: no actual email was sent)',
                email: {
                    id: response?.id,
                    subject: emailContent.subject,
                    recipients: args.to,
                    timestamp: emailTimestamp,
                },
                associations: {
                    contacts: args.contactIds || [],
                    companies: args.companyIds || [],
                    deals: args.dealIds || [],
                    tickets: args.ticketIds || [],
                },
            };
            
            if (templateInfo) {
                result.template = templateInfo;
            }
            
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
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            
            // Try to parse structured error messages
            try {
                const parsed = JSON.parse(errorMessage);
                if (parsed.error && parsed.guidance) {
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(parsed, null, 2),
                            },
                        ],
                        isError: true,
                    };
                }
            }
            catch {
                // Not a structured error, continue
            }
            
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error logging email engagement: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
