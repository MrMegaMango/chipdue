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
const notesSchema = z.string().trim().max(2_000).nullable();

export const financialAccountTypeSchema = z.enum([
	'checking',
	'savings',
	'brokerage',
	'cash_management',
	'other'
]);
export const financialAccountOwnerSchema = z.enum(['personal', 'business']);
export const financialAccountStatusSchema = z.enum(['planned', 'active', 'closed']);
export const bonusStatusSchema = z.enum([
	'planned',
	'active',
	'qualified',
	'pending',
	'paid',
	'closed',
	'abandoned'
]);

const bonusRequirementSchema = z
	.object({
		id: z.uuid().optional(),
		label: z.string().trim().min(1).max(160),
		completed: z.boolean().optional().default(false)
	})
	.strict();

export const cardRewardTypeSchema = z.enum(['points', 'miles', 'cash_back']);

export const cardRewardCategoryMatchSchema = z.enum([
	'dining',
	'groceries',
	'gas',
	'travel',
	'flights_hotels',
	'transit',
	'entertainment',
	'drugstores',
	'streaming',
	'online_shopping',
	'home_improvement',
	'utilities'
]);

const rewardRateSchema = z.number().finite().positive().max(100);

const cardRewardCategorySchema = z
	.object({
		id: z.uuid().optional(),
		name: z.string().trim().min(1).max(60),
		multiplier: rewardRateSchema,
		matchCategory: cardRewardCategoryMatchSchema.nullable().optional().default(null)
	})
	.strict();

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

export const updateCardRewardsSchema = z
	.object({
		rewardProgramName: optionalNameSchema.optional(),
		rewardValueCents: nonnegativeCentsSchema.optional(),
		rewardType: cardRewardTypeSchema.nullable().optional(),
		rewardBaseRate: rewardRateSchema.nullable().optional(),
		rewardCategories: z.array(cardRewardCategorySchema).max(12).optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const applyCardRewardProfileSchema = z
	.object({
		profileId: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9-]+$/)
	})
	.strict();

export const createFinancialAccountSchema = z
	.object({
		nickname: labelSchema,
		institution: optionalNameSchema.optional().default(null),
		accountType: financialAccountTypeSchema,
		ownerType: financialAccountOwnerSchema.optional().default('personal'),
		status: financialAccountStatusSchema.optional().default('active'),
		last4: last4Schema.optional().default(null),
		currency: currencySchema.optional().default('USD'),
		currentBalanceCents: centsSchema.optional().default(null),
		apyBasisPoints: z.number().int().min(0).max(100_000).nullable().optional().default(null),
		costBasisCents: nonnegativeCentsSchema.optional().default(null),
		netContributionsCents: centsSchema.optional().default(null),
		openedDate: isoDateSchema.nullable().optional().default(null),
		notes: notesSchema.optional().default(null)
	})
	.strict();

export const updateFinancialAccountSchema = z
	.object({
		nickname: labelSchema.optional(),
		institution: optionalNameSchema.optional(),
		accountType: financialAccountTypeSchema.optional(),
		ownerType: financialAccountOwnerSchema.optional(),
		status: financialAccountStatusSchema.optional(),
		hidden: z.boolean().optional(),
		last4: last4Schema.optional(),
		currency: currencySchema.optional(),
		currentBalanceCents: centsSchema.optional(),
		apyBasisPoints: z.number().int().min(0).max(100_000).nullable().optional(),
		costBasisCents: nonnegativeCentsSchema.optional(),
		netContributionsCents: centsSchema.optional(),
		openedDate: isoDateSchema.nullable().optional(),
		notes: notesSchema.optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const createBonusSchema = z
	.object({
		accountId: z.uuid().nullable().optional().default(null),
		offerTemplateId: z.string().trim().min(1).max(100).nullable().optional().default(null),
		name: labelSchema,
		institution: optionalNameSchema.optional().default(null),
		rewardCents: nonnegativeCentsSchema.optional().default(null),
		currency: currencySchema.optional().default('USD'),
		status: bonusStatusSchema.optional().default('active'),
		openedDate: isoDateSchema.nullable().optional().default(null),
		requirementDeadline: isoDateSchema.nullable().optional().default(null),
		expectedPayoutDate: isoDateSchema.nullable().optional().default(null),
		paidDate: isoDateSchema.nullable().optional().default(null),
		safeToCloseDate: isoDateSchema.nullable().optional().default(null),
		requirements: z.array(bonusRequirementSchema).max(20).optional().default([]),
		notes: notesSchema.optional().default(null)
	})
	.strict();

export const updateBonusSchema = z
	.object({
		accountId: z.uuid().nullable().optional(),
		offerTemplateId: z.string().trim().min(1).max(100).nullable().optional(),
		name: labelSchema.optional(),
		institution: optionalNameSchema.optional(),
		rewardCents: nonnegativeCentsSchema.optional(),
		currency: currencySchema.optional(),
		status: bonusStatusSchema.optional(),
		openedDate: isoDateSchema.nullable().optional(),
		requirementDeadline: isoDateSchema.nullable().optional(),
		expectedPayoutDate: isoDateSchema.nullable().optional(),
		paidDate: isoDateSchema.nullable().optional(),
		safeToCloseDate: isoDateSchema.nullable().optional(),
		requirements: z.array(bonusRequirementSchema).max(20).optional(),
		notes: notesSchema.optional()
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
export type UpdateCardRewardsData = z.infer<typeof updateCardRewardsSchema>;
export type ApplyCardRewardProfileData = z.infer<typeof applyCardRewardProfileSchema>;
export type CreateFinancialAccountData = z.infer<typeof createFinancialAccountSchema>;
export type UpdateFinancialAccountData = z.infer<typeof updateFinancialAccountSchema>;
export type CreateBonusData = z.infer<typeof createBonusSchema>;
export type UpdateBonusData = z.infer<typeof updateBonusSchema>;
