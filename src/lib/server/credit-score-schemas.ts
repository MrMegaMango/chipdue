import { z } from 'zod';
import { isoDateSchema } from './schemas';

const optionalLabelSchema = z.string().trim().min(1).max(80).nullable();
const notesSchema = z.string().trim().max(2_000).nullable();

export const creditBureauSchema = z.enum(['experian', 'equifax', 'transunion', 'other']);

export const createCreditScoreSchema = z
	.object({
		score: z.number().int().min(300).max(850),
		bureau: creditBureauSchema,
		model: optionalLabelSchema.optional().default(null),
		source: optionalLabelSchema.optional().default(null),
		recordedDate: isoDateSchema,
		notes: notesSchema.optional().default(null)
	})
	.strict();

export const updateCreditScoreSchema = z
	.object({
		score: z.number().int().min(300).max(850).optional(),
		bureau: creditBureauSchema.optional(),
		model: optionalLabelSchema.optional(),
		source: optionalLabelSchema.optional(),
		recordedDate: isoDateSchema.optional(),
		notes: notesSchema.optional()
	})
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export type CreateCreditScoreData = z.infer<typeof createCreditScoreSchema>;
export type UpdateCreditScoreData = z.infer<typeof updateCreditScoreSchema>;
