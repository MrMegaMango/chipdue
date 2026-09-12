export type ConnectionSyncSummary = {
	syncedConnections: number;
	failedConnections: number;
	skippedConnections: number;
};

export function connectionSyncSummary(result: ConnectionSyncSummary): string {
	return `${result.syncedConnections} synced, ${result.failedConnections} failed, ${result.skippedConnections} skipped.`;
}
