import { z } from 'zod';

export const startMethodCreditScoreSchema = z.object({
	firstName: z.string().trim().min(1).max(80),
	lastName: z.string().trim().min(1).max(80),
	phone: z
		.string()
		.trim()
		.regex(/^\+[1-9]\d{7,14}$/, 'Enter a phone number with country code, such as +14155550123.')
});

export type StartMethodCreditScoreData = z.infer<typeof startMethodCreditScoreSchema>;
