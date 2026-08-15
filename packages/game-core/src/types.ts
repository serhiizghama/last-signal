export const RESOURCE_KINDS = ['scrap', 'fuel', 'electronics', 'food'] as const;

export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type Resources = Record<ResourceKind, number>;
