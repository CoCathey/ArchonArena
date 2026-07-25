const { DEFAULT_ELO_CONFIG } = require('../rating/eloDefaults');
const { REGION_NAMES } = require('../rating/regions');

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
 * (object of numeric values, e.g. the key differential multiplier table) |
 * 'stringMap' (object of string values with optional key pattern and
 * allowed-values list) | 'text' (long free text, e.g. Markdown content).
 */
const REGISTRY = {
    rating: {
        title: 'Rating Engine',
        description:
            'SAS-adjusted Elo settings. Changes apply to games finished after the change; the recalculation tool (roadmap) can rebuild history.',
        fields: {
            enabled: { type: 'boolean', label: 'Rated play enabled', default: true },
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
                    highRatingThreshold: {
                        type: 'number',
                        label: 'High-rating tier starts at',
                        min: 0,
                        max: 4000,
                        default: DEFAULT_ELO_CONFIG.highRatingThreshold
                    },
                    highRatingKFactor: {
                        type: 'number',
                        label: 'K-factor (high tier)',
                        min: 1,
                        max: 200,
                        default: DEFAULT_ELO_CONFIG.highRatingKFactor
                    },
                    topRatingThreshold: {
                        type: 'number',
                        label: 'Top-rating tier starts at',
                        min: 0,
                        max: 4000,
                        default: DEFAULT_ELO_CONFIG.topRatingThreshold
                    },
                    topRatingKFactor: {
                        type: 'number',
                        label: 'K-factor (top tier)',
                        min: 1,
                        max: 200,
                        default: DEFAULT_ELO_CONFIG.topRatingKFactor
                    },
                    tournamentKMultiplier: {
                        type: 'number',
                        label: 'Tournament game K multiplier (1 = no bonus)',
                        min: 0.1,
                        max: 5,
                        default: DEFAULT_ELO_CONFIG.tournamentKMultiplier
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
            },
            decay: {
                type: 'section',
                label: 'Rating decay (inactive players)',
                fields: {
                    enabled: { type: 'boolean', label: 'Decay enabled', default: false },
                    graceDays: {
                        type: 'number',
                        label: 'Days of inactivity before decay starts',
                        min: 1,
                        max: 365,
                        default: 30
                    },
                    pointsPerWeek: {
                        type: 'number',
                        label: 'Amber lost per further week of inactivity',
                        min: 1,
                        max: 500,
                        default: 20
                    },
                    floor: {
                        type: 'number',
                        label: 'Decay will not drop a rating below',
                        min: 0,
                        max: 4000,
                        default: 1200
                    }
                }
            },
            season: {
                type: 'section',
                label: 'Seasons',
                fields: {
                    carryFactor: {
                        type: 'number',
                        label: 'Season reset: fraction of the gap from baseline kept (0 = full reset, 1 = no reset)',
                        min: 0,
                        max: 1,
                        default: 0.5
                    },
                    baseline: {
                        type: 'number',
                        label: 'Season reset baseline (ratings regress toward this)',
                        min: 100,
                        max: 4000,
                        default: 1200
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
            },
            maxRequestsPerMinute: {
                type: 'number',
                label: 'DoK requests per minute (25 free tier; 50/100/250 for patron tiers)',
                min: 1,
                max: 250,
                default: 25
            }
        }
    },
    tournament: {
        title: 'Tournaments',
        description:
            'Native tournament engine limits and automation. Per-event settings (format, best-of, caps, SAS bounds) live on each event; these are the site-wide guardrails.',
        fields: {
            maxPlayerCap: {
                type: 'number',
                label: 'Highest player cap an organizer may set',
                min: 2,
                max: 4096,
                default: 512
            },
            autoCreateGames: {
                type: 'boolean',
                label: 'Auto-create lobby games for online event pairings',
                default: true
            },
            allowRated: {
                type: 'boolean',
                label: 'Organizers may mark events as rated (Amber)',
                default: true
            },
            sasPerChain: {
                type: 'number',
                label: 'SAS handicap: 1 starting chain per this many SAS of deck advantage',
                min: 1,
                max: 30,
                default: 5
            },
            maxHandicapChains: {
                type: 'number',
                label: 'Most starting chains an event may assign',
                min: 1,
                max: 24,
                default: 24
            }
        }
    },
    regions: {
        title: 'Regions',
        description:
            'Country-to-region assignments for regional leaderboards. Every country already has a default region (NA, LATAM, EU, MEA, APAC); add an override to move a country. State/province is whatever each player enters and scopes state leaderboards within their country.',
        fields: {
            overrides: {
                type: 'stringMap',
                label: 'Country overrides (ISO country code → region)',
                keyPattern: '^[A-Z]{2}$',
                keyLabel: 'Country code (e.g. US)',
                allowedValues: REGION_NAMES,
                default: {}
            }
        }
    },
    content: {
        title: 'Site Content',
        description:
            'Replace the built-in About and Privacy pages with your own content (Markdown: # headings, **bold**, [links](url), - lists). Leave a field empty to keep the built-in page.',
        fields: {
            aboutMarkdown: {
                type: 'text',
                label: 'About page (Markdown; empty = built-in page)',
                maxLength: 50000,
                default: ''
            },
            privacyMarkdown: {
                type: 'text',
                label: 'Privacy page (Markdown; empty = built-in page)',
                maxLength: 50000,
                default: ''
            }
        }
    },
    navigation: {
        title: 'Navigation & Pages',
        description:
            'Show or hide the optional Community content pages. Turning a page off removes its link from the sidebar navigation.',
        fields: {
            showNews: { type: 'boolean', label: 'Show the News page', default: true },
            showArticles: { type: 'boolean', label: 'Show the Articles page', default: true },
            showBlogs: { type: 'boolean', label: 'Show the Blogs page', default: true },
            showForums: { type: 'boolean', label: 'Show the Forums page', default: true }
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
    } else if (descriptor.type === 'text') {
        if (typeof value !== 'string') {
            errors.push(`${path} must be text`);
        } else if (descriptor.maxLength !== undefined && value.length > descriptor.maxLength) {
            errors.push(`${path} must be at most ${descriptor.maxLength} characters`);
        }
    } else if (descriptor.type === 'stringMap') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            errors.push(`${path} must be an object`);
        } else {
            for (const [key, entry] of Object.entries(value)) {
                if (descriptor.keyPattern && !new RegExp(descriptor.keyPattern).test(key)) {
                    errors.push(`${path} has invalid key '${key}'`);
                } else if (typeof entry !== 'string') {
                    errors.push(`${path}.${key} must be a string`);
                } else if (descriptor.allowedValues && !descriptor.allowedValues.includes(entry)) {
                    errors.push(`${path}.${key} has unknown value '${entry}'`);
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
