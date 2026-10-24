export * from './service.js';
export * from './provider-bridge.js';
export * from './registry-client.js';

// Re-exported so presentation layers can render the same deduplicated entry set
// the install/push/search flows act on. Raw `InspectionReport.groups` overlap by
// design (the deep-scan fallback re-finds entries a native layout already
// matched), so rendering them directly double-counts skills.
export { listInstallableEntries } from '@agentpm/adapters';
