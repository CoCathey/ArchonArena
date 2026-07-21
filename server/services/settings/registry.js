const { DEFAULT_ELO_CONFIG } = require('../rating/eloDefaults');

/**
 * Registry of runtime admin-editable settings.
 *
 * Each section maps to one SiteSettings row (jsonb overrides merged over
 * code defaults + file config). Field descriptors drive both server-side
 * validation and the admin UI. Anything NOT listed here cannot be edited
 * at runtime (secrets like API keys and OIDC credentials stay env-only
 * on purpose).
 *
 * Field types: 'boolean' | 'number' | 'stringArray' | 'numberMap'
 * (object of numeric values, e.g. the key differential multiplier table).
 */
const REGISTRY = {
    rating: {
        title: 'Rating Engine',
        description:
            'SAS-adjusted Elo settings. Changes apply to games finished after the change; the recalculation tool (roadmap) can rebuild history.',
        fields: {
            enabled: { type: 'boolean', label: 'Rated play enabled', default: true },
            ratedTypes: {
                type: 'stringArray',
                label: 'Rated game types',
                allowed: ['beginner', 'casual', 'competitive'],
                default: ['casual', 'competitive']
            },
            leaderboardMinGames: {
                type: 'number',
                label: 'Games required for leaderboards',
                min: 0,
                max: 1000,
                default: 5
            },
            elo: {
                type: 'section',
                label: 'Elo parameters',
                fields: {
                    defaultRating: {
                        type: 'number',
                        label: 'Starting rating',
                        min: 100,
                        max: 4000,
                        default: DEFAULT_ELO_CONFIG.defaultRating
                    },
                    ratingFloor: {
                        type: 'number',
                        label: 'Rating floor',
                        min: 0,
                        max: 2000,
                        default: DEFAULT_ELO_CONFIG.ratingFloor
                    },
                    kFactor: {
                        type: 'number',
                        label: 'K-factor (established)',
                        min: 1,
                        max: 200,
                        default: DEFAULT_ELO_CONFIG.kFactor
                    },
                    provisionalKFactor: {
                        type: 'number',
                        label: 'K-factor (provisional)',
                        min: 1,
                        max: 400,
                        default: DEFAULT_ELO_CONFIG.provisionalKFactor
                    },
                    provisionalGames: {
                        type: 'number',
                        label: 'Provisional game count',
                        min: 0,
                        max: 100,
                        default: DEFAULT_ELO_CONFIG.provisionalGames
                    },
                    sasWeight: {
                        type: 'number',
                        label: 'SAS weight (rating points per SAS point)',
                        min: 0,
                        max: 50,
                        default: DEFAULT_ELO_CONFIG.sasWeight
                    },
                    keyDiffMultipliers: {
                        type: 'numberMap',
                        label: 'Key differential multipliers (1=3-2, 2=3-1, 3=3-0)',
                        keys: ['1', '2', '3'],
                        min: 0.1,
                        max: 5,
                        default: DEFAULT_ELO_CONFIG.keyDiffMultipliers
                    },
                    resultTypeMultipliers: {
                        type: 'numberMap',
                        label: 'Result type multipliers',
                        keys: ['keys', 'concede', 'timeout'],
                        min: 0.1,
                        max: 5,
                        default: DEFAULT_ELO_CONFIG.resultTypeMultipliers
                    }
                }
            }
        }
    },
    dok: {
        title: 'Decks of KeyForge',
        description:
            'SAS enrichment behaviour. The API key itself is configured via the DOK_API_KEY environment variable.',
        fields: {
            enabled: { type: 'boolean', label: 'SAS fetching enabled', default: true },
            refreshDays: {
                type: 'number',
                label: 'Refresh cached SAS after (days)',
                min: 1,
                max: 365,
                default: 30
            },
            requestTimeoutMs: {
                type: 'number',
                label: 'DoK request timeout (ms)',
                min: 1000,
                max: 60000,
                default: 10000
            }
        }
    }
};

function validateField(descriptor, value, path, errors) {
    if (descriptor.type === 'boolean') {
        if (typeof value !== 'boolean') {
            errors.push(`${path} must be true or false`);
        }
    } else if (descriptor.type === 'number') {
        if (typeof value !== 'number' || Number.isNaN(value)) {
            errors.push(`${path} must be a number`);
        } else if (descriptor.min !== undefined && value < descriptor.min) {
            errors.push(`${path} must be at least ${descriptor.min}`);
        } else if (descriptor.max !== undefined && value > descriptor.max) {
            errors.push(`${path} must be at most ${descriptor.max}`);
        }
    } else if (descriptor.type === 'stringArray') {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
            errors.push(`${path} must be a list of strings`);
        } else if (descriptor.allowed) {
            for (const entry of value) {
                if (!descriptor.allowed.includes(entry)) {
                    errors.push(`${path} contains unknown value '${entry}'`);
                }
            }
        }
    } else if (descriptor.type === 'numberMap') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push(`${path} must be an object of numbers`);
        } else {
            for (const [key, entry] of Object.entries(value)) {
                if (descriptor.keys && !descriptor.keys.includes(key)) {
                    errors.push(`${path} has unknown key '${key}'`);
                } else if (typeof entry !== 'number' || Number.isNaN(entry)) {
                    errors.push(`${path}.${key} must be a number`);
                } else if (descriptor.min !== undefined && entry < descriptor.min) {
                    errors.push(`${path}.${key} must be at least ${descriptor.min}`);
                } else if (descriptor.max !== undefined && entry > descriptor.max) {
                    errors.push(`${path}.${key} must be at most ${descriptor.max}`);
                }
            }
        }
    }
}

function validateAgainstFields(fields, value, prefix, errors) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push(`${prefix || 'value'} must be an object`);

        return;
    }

    for (const [key, entry] of Object.entries(value)) {
        const descriptor = fields[key];
        const path = prefix ? `${prefix}.${key}` : key;

        if (!descriptor) {
            errors.push(`${path} is not an editable setting`);
            continue;
        }

        if (descriptor.type === 'section') {
            validateAgainstFields(descriptor.fields, entry, path, errors);
        } else {
            validateField(descriptor, entry, path, errors);
        }
    }
}

/**
 * Validate a partial overrides object for a section. Returns a list of
 * error strings; empty means valid. Partial objects are fine — only the
 * provided fields are checked (they override defaults field-by-field).
 */
function validateSection(section, value) {
    const errors = [];
    const definition = REGISTRY[section];

    if (!definition) {
        return [`Unknown settings section '${section}'`];
    }

    validateAgainstFields(definition.fields, value, '', errors);

    return errors;
}

module.exports = { REGISTRY, validateSection };
