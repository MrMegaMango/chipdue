import type { DashboardResponse } from './dashboard';

type DashboardLoaderOptions = {
	isCurrent: (epoch: number) => boolean;
	request: (epoch: number) => Promise<DashboardResponse>;
	start: (quiet: boolean) => void;
	apply: (response: DashboardResponse) => boolean;
	fail: (error: unknown) => void;
	finish: () => void;
};

export function createDashboardLoader(options: DashboardLoaderOptions) {
	let loadVersion = 0;

	return async (quiet: boolean, epoch: number): Promise<boolean> => {
		if (!options.isCurrent(epoch)) return false;
		const version = ++loadVersion;
		const isCurrent = () => version === loadVersion && options.isCurrent(epoch);
		options.start(quiet);
		try {
			// Each load requests a fresh snapshot, including a refresh after a mutation.
			const response = await options.request(epoch);
			if (!isCurrent()) return false;
			return options.apply(response);
		} catch (error) {
			if (isCurrent()) options.fail(error);
			return false;
		} finally {
			if (isCurrent()) options.finish();
		}
	};
}
