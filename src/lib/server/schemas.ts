import { z } from 'zod';

const MAX_CENTS = 100_000_000_000;

export const idSchema = z.uuid();

export const isoDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.refine((value) => {
		const [year, month, day] = value.split('-').map(Number);
		const date = new Date(Date.UTC(year, month - 1, day));
		return (
			date.getUTCFullYear() === year &&
			date.getUTCMonth() === month - 1 &&
			date.getUTCDate() === day
		);
	}, 'Invalid calendar date');

const labelSchema = z.string().trim().min(1).max(80);
const optionalNameSchema = z.string().trim().min(1).max(80).nullable();
const last4Schema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9]{4}$/)
	.nullable();
const currencySchema = z
	.string()
	.trim()
	.toUpperCase()
	.regex(/^[A-Z]{3}$/);
const centsSchema = z.number().int().min(-MAX_CENTS).max(MAX_CENTS).nullable();
const nonnegativeCentsSchema = z.number().int().min(0).max(MAX_CENTS).nullable();

export const createManualCardSchema = z
	.object({
		nickname: labelSchema,
		issuer: optionalNameSchema.optional().default(null),
		last4: last4Schema.optional().default(null),
		currency: currencySchema.optional().default('USD'),
		statementBalanceCents: centsSchema.optional().default(null),
		minimumPaymentCents: nonnegativeCentsSchema.optional().default(null),
		currentBalanceCents: centsSchema.optional().default(null),
		dueDate: isoDateSchema.nullable().optional().default(null),
		statementDate: isoDateSchema.nullable().optional().default(null),
		isOverdue: z.boolean().nullable().optional().default(null),
		autopayEnabled: z.boolean().optional().default(false)
	})
	.strict();

export const updateManualCardSchema = z
	.object({
		nickname: labelSchema.optional(),
		issuer: optionalNameSchema.optional(),
		last4: last4Schema.optional(),
		currency: currencySchema.optional(),
		statementBalanceCents: centsSchema.optional(),
		minimumPaymentCents: nonnegativeCentsSchema.optional(),
		currentBalanceCents: centsSchema.optional(),
		dueDate: isoDateSchema.nullable().optional(),
		statementDate: isoDateSchema.nullable().optional(),
		isOverdue: z.boolean().nullable().optional(),
		autopayEnabled: z.boolean().optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const exchangeTokenSchema = z
	.object({
		publicToken: z.string().min(1).max(512),
		institutionName: z.string().trim().min(1).max(80).nullable().optional().default(null)
	})
	.strict();

export type CreateManualCardData = z.infer<typeof createManualCardSchema>;
export type UpdateManualCardData = z.infer<typeof updateManualCardSchema>;
