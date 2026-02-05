import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { BaseTool } from '../baseTool.js';
import HubSpotClient from '../../utils/client.js';

// Helper to coerce string to number for IDs
const coerceToInt = z.union([
    z.number().int(),
    z.string().regex(/^\d+$/).transform(Number)
]);

const SendMarketingEmailSchema = z.object({
    emailId: coerceToInt
        .describe('Marketing Email template ID. Use hubspot-list-email-templates to find templates.'),
    to: z
        .string()
        .email()
        .describe('Recipient email address (single recipient only for Single Send API)'),
    
    // Optional unique ID to prevent duplicate sends
    sendId: z
        .string()
        .optional()
        .describe('Unique identifier to prevent duplicate sends. Recommended for idempotency.'),
    
    // Email headers
    from: z
        .string()
        .optional()
        .describe('Sender display format: "Name <email@domain.com>" or just "email@domain.com"'),
    replyTo: z
        .array(z.string().email())
        .optional()
        .describe('Reply-to email addresses'),
    cc: z
        .array(z.string().email())
        .optional()
        .describe('CC recipient email addresses'),
    bcc: z
        .array(z.string().email())
        .optional()
        .describe('BCC recipient email addresses'),
    
    // Personalization
    contactProperties: z
        .record(z.any())
        .optional()
        .describe('Contact property values for personalization tokens (e.g., {"firstname": "John", "company": "Acme"})'),
    customProperties: z
        .record(z.any())
        .optional()
        .describe('Custom HubL variables for template rendering (e.g., {"productName": "Widget", "price": "$99"})'),
});

const ToolDefinition = {
    name: 'hubspot-send-marketing-email',
    description: `
    🛡️ Guardrails:
      1. Data Modification Warning: This tool sends an ACTUAL email to real recipients.
      2. Only use when the user has explicitly requested to send an email.
      3. Verify recipient email addresses before sending.

    🎯 Purpose:
      Sends a real marketing email using HubSpot's Single Send API.
      
    ⚠️ REQUIREMENTS:
      - Marketing Hub ENTERPRISE plan
      - "marketing-email" OR "transactional-email" OAuth scope
      
      This tool will FAIL on Professional/Starter plans with a clear error message.

    📋 Prerequisites:
      1. Use hubspot-list-email-templates to find the emailId of the template you want to send.
      2. Ensure your HubSpot account has Marketing Hub Enterprise.
      3. Verify the private app has the "marketing-email" scope.

    🧭 Usage Guidance:
      1. The emailId must be a published Marketing Email (not a draft).
      2. Single Send API sends to ONE recipient at a time - use loops for bulk sending.
      3. Use sendId to prevent duplicate sends (same sendId = idempotent operation).
      4. contactProperties override contact record values for personalization tokens.
      5. customProperties provide values for custom HubL variables in the template.
      
    📧 Email Delivery:
      - Email is ACTUALLY sent to the recipient's inbox
      - Engagement is automatically logged in CRM
      - Automatically associates with matching contact records
      - Respects unsubscribe preferences and email quotas
  `,
    inputSchema: zodToJsonSchema(SendMarketingEmailSchema),
    annotations: {
        title: 'Send Marketing Email (Enterprise)',
        readOnlyHint: false,
        destructiveHint: true,  // Actually sends email!
        idempotentHint: true,   // When using sendId
        openWorldHint: true,
    },
};

export class SendMarketingEmailTool extends BaseTool {
    client;
    
    constructor() {
        super(SendMarketingEmailSchema, ToolDefinition);
        this.client = new HubSpotClient();
    }
    
    buildMessagePayload(args) {
        const message = {
            to: args.to,
        };
        
        if (args.sendId) {
            message.sendId = args.sendId;
        }
        
        if (args.from) {
            message.from = args.from;
        }
        
        if (args.replyTo?.length) {
            message.replyTo = args.replyTo;
        }
        
        if (args.cc?.length) {
            message.cc = args.cc;
        }
        
        if (args.bcc?.length) {
            message.bcc = args.bcc;
        }
        
        return message;
    }
    
    async process(args) {
        try {
            // Build the request body according to HubSpot Single Send API spec
            const requestBody = {
                emailId: args.emailId,
                message: this.buildMessagePayload(args),
            };
            
            // Add optional personalization properties
            if (args.contactProperties) {
                requestBody.contactProperties = args.contactProperties;
            }
            
            if (args.customProperties) {
                requestBody.customProperties = args.customProperties;
            }
            
            // Call the Single Send API
            const response = await this.client.post('/marketing/v4/email/single-send', {
                body: requestBody,
            });
            
            const result = {
                status: 'success',
                message: 'Marketing email sent successfully',
                email: {
                    emailId: args.emailId,
                    recipient: args.to,
                    sendId: args.sendId,
                    statusId: response?.statusId,
                    sendResult: response?.sendResult,
                },
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
            
            // Check for plan/scope errors (most common issue)
            if (errorMessage.includes('403') || 
                errorMessage.toLowerCase().includes('forbidden') ||
                errorMessage.toLowerCase().includes('upgrade') ||
                errorMessage.toLowerCase().includes('subscription')) {
                
                const errorResponse = {
                    error: 'ENTERPRISE_REQUIRED',
                    message: 'The Single Send API requires Marketing Hub Enterprise and the "marketing-email" scope.',
                    currentPlan: 'Marketing Hub Professional (detected from error)',
                    guidance: [
                        'Option 1: Upgrade to Marketing Hub Enterprise to unlock the Single Send API.',
                        'Option 2: Use hubspot-log-email-engagement to record emails sent through other systems.',
                        'Option 3: Send emails manually through HubSpot UI or connected inbox (Gmail/Outlook).',
                    ],
                    apiEndpoint: '/marketing/v4/email/single-send',
                    requiredScope: 'marketing-email OR transactional-email',
                    requiredPlan: 'Marketing Hub Enterprise',
                    documentation: 'https://developers.hubspot.com/docs/api/marketing/marketing-email',
                    originalError: errorMessage,
                };
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(errorResponse, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
            
            // Check for missing scope error
            if (errorMessage.toLowerCase().includes('scope')) {
                const errorResponse = {
                    error: 'MISSING_SCOPE',
                    requiredScope: 'marketing-email OR transactional-email',
                    message: 'The HubSpot access token is missing the required scope to send marketing emails.',
                    guidance: [
                        'Add the "marketing-email" scope to your HubSpot private app configuration.',
                        'Regenerate the access token after adding the scope.',
                        'Note: This feature still requires Marketing Hub Enterprise plan.',
                    ],
                    originalError: errorMessage,
                };
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(errorResponse, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
            
            // Check for not found (invalid emailId)
            if (errorMessage.includes('404') || errorMessage.toLowerCase().includes('not found')) {
                const errorResponse = {
                    error: 'EMAIL_NOT_FOUND',
                    emailId: args.emailId,
                    message: `Marketing Email with ID ${args.emailId} was not found.`,
                    guidance: [
                        'Use hubspot-list-email-templates to search for available email templates.',
                        'Verify the emailId is correct.',
                        'Ensure the email is published (not in draft state).',
                    ],
                    originalError: errorMessage,
                };
                
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(errorResponse, null, 2),
                        },
                    ],
                    isError: true,
                };
            }
            
            // Generic error
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error sending marketing email: ${errorMessage}`,
                    },
                ],
                isError: true,
            };
        }
    }
}
