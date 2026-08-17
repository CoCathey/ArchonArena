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
            leaderboardActivityDays: {
                type: 'number',
                label: 'Only rank players active within (days; 0 = rank everyone)',
                min: 0,
                max: 3650,
                default: 0
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
                    },
                    autoApplyHours: {
                        type: 'number',
                        label: 'Auto-apply decay every N hours (0 = manual only)',
                        min: 0,
                        max: 168,
                        default: 24
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
            },
            // ARCHON (N19): ARI, the Archon Rating Index - the deck rating the
            // Elo deck term reads instead of raw SAS while enabled.
            ari: {
                type: 'section',
                label: 'ARI (Archon Rating Index)',
                fields: {
                    enabled: {
                        type: 'boolean',
                        label: 'Use ARI (seeded from SAS/AERC, moved by results) as the deck term',
                        default: true
                    },
                    gameK: {
                        type: 'number',
                        label: 'ARI movement per rated real game (Elo points per unit surprise)',
                        min: 0,
                        max: 64,
                        default: 8
                    },
                    simGameK: {
                        type: 'number',
                        label: "ARI movement per Champion's Challenge sparring game",
                        min: 0,
                        max: 64,
                        default: 4
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
            // Lowerable, not raisable: 25 is DoK's free tier and the service
            // clamps to it regardless of what is stored here, so a higher
            // number would be a setting that silently does nothing. Patron
            // tiers allow more, but the windows enforcing this are per lobby
            // process, and whether a key really has that tier is DoK's business
            // rather than ours - so spending it takes a code change by someone
            // who has checked, not a slider moved during an incident.
            maxRequestsPerMinute: {
                type: 'number',
                label: 'DoK requests per minute (25 is the free-tier cap and the maximum here)',
                min: 1,
                max: 25,
                default: 25
            },
            sweepEnabled: {
                type: 'boolean',
                label: 'Refresh stale SAS in the background (otherwise only when a deck is opened)',
                default: true
            },
            sweepBatchSize: {
                type: 'number',
                label: 'Decks the background sweep refreshes per run (it stops early if live traffic needs the budget)',
                min: 1,
                max: 200,
                default: 10
            },
            // ARCHON (N27): two sweeps spend this budget on nobody's behalf -
            // the stale-SAS refresh and the Gauntlet asking about pool decks -
            // and peek-and-take alone lets either of them take the minute's last
            // slot. A member arriving a second later then sees no SAS at all,
            // which from their side is indistinguishable from DoK being down.
            backgroundHeadroom: {
                type: 'number',
                label: 'Requests each minute reserved for members (background sweeps leave these alone)',
                min: 0,
                max: 24,
                default: 5
            }
        }
    },
    // ARCHON: the Master Vault name index behind deck search.
    catalog: {
        title: 'Deck Catalog',
        description:
            "The Master Vault index that lets players find a deck by name instead of pasting a link. Crawling is off by default: it walks somebody else's API from the same address as user-facing deck import, so turning it on is an operator's decision, and these knobs are how you keep it polite. Searching an index that already exists costs Master Vault nothing and is controlled separately.",
        fields: {
            enabled: {
                type: 'boolean',
                label: 'Crawl Master Vault to index new decks',
                default: false
            },
            searchEnabled: {
                type: 'boolean',
                label: 'Players may search the catalog by deck name',
                default: true
            },
            // pageSize is deliberately NOT editable here. The crawl cursor is a
            // page NUMBER, and page N only means the same decks forever while
            // the page size never changes. Editing it mid-crawl re-aims the
            // cursor at a different offset, and because the cursor only ever
            // moves forward the decks in between are skipped permanently - an
            // invisible hole in a table whose whole point is that you cannot
            // tell what is missing from it. Changing it belongs with a cursor
            // reset, which is a deploy, not a checkbox.
            pagesPerRun: {
                type: 'number',
                label: 'Pages fetched per crawl run',
                min: 1,
                max: 100,
                default: 10
            },
            requestDelayMs: {
                type: 'number',
                label: 'Wait between Master Vault requests (ms)',
                min: 500,
                max: 60000,
                default: 3000
            },
            maxConsecutiveFailures: {
                type: 'number',
                label: 'Failures in a row before the crawl backs off',
                min: 1,
                max: 20,
                default: 3
            },
            crawlIntervalMinutes: {
                type: 'number',
                label: 'Start a crawl run every (minutes)',
                min: 1,
                max: 1440,
                default: 15
            },
            maxSearchResults: {
                type: 'number',
                label: 'Most results a single name search returns',
                min: 5,
                max: 200,
                default: 50
            }
        }
    },
    // ARCHON: the background worker behind bulk collection import.
    deckImport: {
        title: 'Collection Import',
        description:
            "Importing a whole Decks of KeyForge collection runs as a job the lobby works a few decks at a time, so it survives the player closing the modal. These knobs are the pace it pulls decks from Master Vault, and that pace is shared rather than per-player: the worker uses the same origin as every player importing a single deck by hand, and Master Vault meters the origin. Turning them up buys a faster bulk import at the cost of somebody else's deck link being refused.",
        fields: {
            enabled: {
                type: 'boolean',
                label: 'Import collections in the background',
                default: true
            },
            decksPerTick: {
                type: 'number',
                label: 'Decks imported per sweep',
                min: 1,
                max: 50,
                default: 5
            },
            requestSpacingMs: {
                type: 'number',
                label: 'Wait between deck imports within a sweep (ms)',
                min: 100,
                max: 60000,
                default: 400
            },
            // No failure-threshold knob here, unlike the catalog crawl. A job
            // parks on the FIRST Master Vault rate limit, so there is no
            // threshold to tune - and a setting labelled "failures in a row
            // before a job backs off" that changes nothing is worse than no
            // setting, because an operator reaches for it precisely when the
            // import is misbehaving and will believe they have adjusted it.
            sweepIntervalSeconds: {
                type: 'number',
                label: 'Work each import job every (seconds)',
                min: 5,
                max: 3600,
                default: 10
            }
            // The backoff curve (backoffBaseMs / backoffMaxMs) is deliberately
            // NOT editable here. It is the site's protection against Master
            // Vault, and the moment anyone would reach for it is the middle of
            // a rate-limiting incident - which is exactly when shortening a
            // backoff turns "Master Vault is throttling us" into "Master Vault
            // has blocked this address", taking ordinary deck import with it.
            // The knob for an operator in that situation is `enabled`.
            //
            // maxJobDecks is not editable either, for a different reason: it
            // bounds how many uuids go into one row's JSON blob, so it is a
            // statement about what the table is shaped to hold rather than
            // about pacing. What actually limits a player's import is
            // dok.maxImportDecks, which they hit first.
        }
    },
    // ARCHON (N18): the Champion’s Challenge - Vault Master background deck testing.
    championsChallenge: {
        title: 'Champion’s Challenge',
        description:
            'Background deck testing for Vault Master members: the lobby quietly plays enrolled ' +
            'decks against each other with a simulated player and reports how each deck performs ' +
            'against what its SAS predicts. Simulated games live in their own tables and can ' +
            'never touch Amber, deck records or any statistic. Each game costs the lobby ' +
            'roughly half a second of CPU, spread out with event-loop yields - the pace knobs ' +
            'below are what an operator reaches for if that ever shows.',
        fields: {
            enabled: {
                type: 'boolean',
                label: 'Play simulated games in the background',
                default: true
            },
            sweepIntervalSeconds: {
                type: 'number',
                label: 'Play a batch of games every (seconds)',
                min: 15,
                max: 3600,
                default: 60
            },
            gamesPerSweep: {
                type: 'number',
                label: 'Games played per batch, across all members',
                min: 1,
                max: 10,
                default: 2
            },
            gamesPerDeckPerDay: {
                type: 'number',
                label: 'Most games one deck plays per day (UTC)',
                min: 0,
                max: 200,
                default: 12
            },
            maxEnrolledPerUser: {
                type: 'number',
                label: 'Decks one member may enroll at once',
                min: 2,
                max: 32,
                default: 8
            },
            // A safety valve, not a pacing knob: a simulated game that is
            // still going after this many player turns is assumed wedged,
            // abandoned, and recorded nowhere.
            maxTurnsPerGame: {
                type: 'number',
                label: 'Abandon a simulated game after (turns)',
                min: 20,
                max: 200,
                default: 80
            },
            // ARCHON (N21): the learning bot. Off switches the sparring
            // partner back to the fixed heuristics and stops all training,
            // arena play and deep games in one move.
            learningEnabled: {
                type: 'boolean',
                label: 'Learning bot: train from games and play with the champion model',
                default: true
            },
            trainEveryGames: {
                type: 'number',
                label: 'Train a new candidate every (logged games)',
                min: 10,
                max: 1000,
                default: 25
            },
            trainingGamesKept: {
                type: 'number',
                label: 'Training games kept (older pruned)',
                min: 100,
                max: 50000,
                default: 4000
            },
            // ARCHON (N25): how adventurously the fast bot plays, and how fast
            // that settles. A young model must try second-best moves to learn
            // they were best; a mature one is mostly being made worse by the
            // noise. The floor stays above zero so a policy can still notice the
            // day its habits stopped working.
            explorationTemperature: {
                type: 'number',
                label: 'Starting exploration temperature',
                min: 0,
                max: 3,
                default: 0.7
            },
            explorationFloor: {
                type: 'number',
                label: 'Exploration temperature it settles toward',
                min: 0,
                max: 1,
                default: 0.15
            },
            explorationHalfLife: {
                type: 'number',
                label: 'Trained games that halve the exploration bonus',
                min: 100,
                max: 1000000,
                default: 20000
            },
            trainingLambda: {
                type: 'number',
                // 0 restores the pre-N25 behaviour: every decision labelled by
                // the final result, however little the result had to do with it.
                label: 'How far training leans on the next position’s value (0-1)',
                min: 0,
                max: 1,
                default: 0.5
            },
            arenaMinGames: {
                type: 'number',
                // ARCHON (N25): a floor under the sequential test, not a sample
                // size. The test decides when the evidence is enough; this only
                // stops a short streak from taking the title, so it is
                // deliberately small - a large minimum would throw away exactly
                // the early stopping it is guarding.
                label: 'Arena games before a candidate may take the title at all',
                min: 10,
                max: 2000,
                default: 30
            },
            arenaDecideGames: {
                type: 'number',
                label: 'Arena games before an unproven candidate retires',
                min: 50,
                max: 5000,
                default: 400
            },
            // ARCHON (N28): three sparring pilots instead of one. A deck's win
            // rate used to mean "how this deck does against this bot", so a deck
            // that punished the bot's habits carried a rating that said it was
            // strong. Rotating three styles averages that out, and the spread
            // between them is a fact about the deck. See labPersonas.js.
            personasEnabled: {
                type: 'boolean',
                label: 'Rotate three sparring styles instead of playing one (better ratings)',
                default: true
            },
            personaStrength: {
                type: 'number',
                // A persona is the champion pulled away from its own best play,
                // so this dial trades style for strength: too high and the pilots
                // are simply bad players, which measures which decks punish bad
                // play instead of which decks depend on the matchup. The duels
                // are how you see that happening.
                label: 'How strongly a style pulls the bot away from its best play (0 = off)',
                min: 0,
                max: 3,
                default: 1
            },
            personaDuelPairsPerSweep: {
                type: 'number',
                // One pair is two games - the same seed played twice with the
                // pilots swapped between seats.
                label: 'Style-versus-style calibration pairs per sweep (0 = never calibrate)',
                min: 0,
                max: 10,
                default: 1
            },
            // The deep planner: fewer, slower, annotated showcase games. A
            // deep game costs seconds-to-minutes of CPU where a fast one
            // costs half a second - these knobs are the leash.
            deepGamesPerDay: {
                type: 'number',
                label: 'Deep showcase games per roster per day (0 = none)',
                min: 0,
                max: 20,
                default: 2
            },
            deepMaxAnalyzedDecisions: {
                type: 'number',
                label: 'Decisions analyzed per deep game',
                min: 2,
                max: 40,
                default: 10
            },
            deepCandidates: {
                type: 'number',
                label: 'Candidate moves tried per analyzed decision',
                min: 2,
                max: 12,
                default: 5
            },
            deepSamples: {
                type: 'number',
                label: 'Sampled futures per candidate move',
                min: 1,
                max: 8,
                default: 2
            },
            deepRolloutTurns: {
                type: 'number',
                label: 'Turns each sampled future is played forward',
                min: 2,
                max: 20,
                default: 5
            },
            // ARCHON (N24): the Gauntlet - members' decks against strangers'
            // decks, drawn from the Master Vault catalog. Hydrating a pool deck
            // costs one Master Vault request, once and forever, and only
            // happens while at least one member has the Gauntlet switched on -
            // but it is the same outbound budget user-facing deck import
            // spends, so the operator owns the pacing.
            gauntletEnabled: {
                type: 'boolean',
                label: 'Members may play their decks against the field (the Gauntlet)',
                default: true
            },
            gauntletDecksPerRun: {
                type: 'number',
                label: 'Catalog decks hydrated into the pool per sweep',
                min: 1,
                max: 50,
                default: 5
            },
            gauntletTargetPoolSize: {
                type: 'number',
                label: 'Playable pool size to stop hydrating at',
                min: 20,
                max: 20000,
                default: 400
            },
            gauntletRequestDelayMs: {
                type: 'number',
                label: 'Pause between Master Vault deck fetches (ms)',
                min: 0,
                max: 30000,
                default: 1500
            },
            gauntletRequestTimeoutMs: {
                type: 'number',
                label: 'Master Vault deck fetch timeout (ms)',
                min: 1000,
                max: 60000,
                default: 10000
            },
            // ARCHON (N30): reading a pool deck's own cards to work out what it
            // is built to do. Pure CPU over cards already stored - no outbound
            // request, nobody's rate limit - so this is only about not stalling a
            // sweep tick on a pool of thousands.
            gauntletProfilePerRun: {
                type: 'number',
                label: 'Pool decks read from their own cards per sweep',
                min: 1,
                max: 500,
                default: 50
            },
            gauntletEnrichPerRun: {
                type: 'number',
                label: 'Pool decks sent for SAS/AERC enrichment per sweep',
                min: 0,
                max: 25,
                default: 5
            },
            // ARCHON (N27): Master Vault registers decks Decks of KeyForge does
            // not rate, and "no SAS row" cannot tell those from decks nobody has
            // asked about yet. Every ask is stamped, so this is how long before
            // an unanswered deck is worth asking about again - long, because the
            // usual answer does not change week to week.
            gauntletEnrichRetryDays: {
                type: 'number',
                label: 'Days before asking again about a pool deck DoK had no SAS for',
                min: 1,
                max: 365,
                default: 30
            },
            // ARCHON (N24): where the simulated games actually run. Sparring is
            // solid CPU with nobody waiting on it, so it can be moved off the
            // lobby onto its own node (npm run challenge). Whoever sweeps holds
            // a database lease, so switching this is safe at runtime and the two
            // can never both play.
            sweepOwner: {
                type: 'select',
                label: 'Which node plays the simulated games',
                options: [
                    { value: 'lobby', label: 'The lobby (default)' },
                    { value: 'worker', label: 'A dedicated Challenge worker node' },
                    { value: 'any', label: 'Whichever node claims the lease first' }
                ],
                default: 'lobby'
            },
            sweepLeaseSeconds: {
                type: 'number',
                label: 'Seconds before a silent sweeper’s lease can be taken over',
                min: 30,
                max: 3600,
                default: 120
            }
        }
    },
    // ARCHON (F9): the practice bots - one per house, always hosting an open
    // table in the lobby.
    //
    // `page` moves a section off the general Site Settings screen and onto a
    // screen of its own: these knobs belong next to the roster they govern
    // (names, pictures, profiles, which bots play), and that roster is not
    // registry-shaped. The section is still stored, validated and audited
    // exactly like every other one - only where it is EDITED changes.
    bots: {
        title: 'Bots',
        page: 'bots',
        description:
            'Practice bots host an open game in the lobby around the clock. Anyone can join, and ' +
            'the game starts the moment they pick a deck. Each bot belongs to a house and only ' +
            'plays decks containing it; a table that gets joined is replaced by one hosted by a ' +
            'different bot. Practice games are never persisted or rated and can never touch ' +
            'Amber, deck records or any statistic. Nobody can log into a bot account.',
        fields: {
            enabled: {
                type: 'boolean',
                label: 'Keep an open practice table in the lobby',
                default: true
            },
            maxConcurrentGames: {
                type: 'number',
                label: 'Most bot games running at once (a new table opens while under this)',
                min: 1,
                max: 20,
                default: 3
            },
            pendingRecycleMinutes: {
                type: 'number',
                label: 'Re-open a table whose joiner never picked a deck after (minutes)',
                min: 1,
                max: 120,
                default: 10
            },
            allowSpectators: {
                type: 'boolean',
                label: 'Allow spectators on bot games',
                default: true
            },
            // ARCHON (F9): the bot decides in microseconds, and a whole turn
            // landing in one frame reads as a glitch rather than an
            // opponent. This is the pause between its plays (jittered a
            // little either side), not a handicap: it still plays far faster
            // than a person. Zero plays instantly.
            thinkMs: {
                type: 'number',
                label: 'Bot pauses between plays (milliseconds; 0 = instant)',
                min: 0,
                max: 5000,
                default: 700
            },
            // ARCHON (N21): the practice bots play the Champion's Challenge's
            // reigning model, so the lab's learning shows up in the lobby.
            // Off falls back to the plain heuristics, which is also what a
            // site that has not crowned a champion yet plays.
            useLearnedPolicy: {
                type: 'boolean',
                label: 'Bots play the learned Champion’s Challenge policy',
                default: true
            },
            // A safety valve, not a pacing knob: past this many rounds the
            // bot concedes so the table can never be held forever.
            maxTurns: {
                type: 'number',
                label: 'Bot concedes past (rounds)',
                min: 20,
                max: 200,
                default: 80
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
    replay: {
        title: 'Replays',
        description:
            'How long recorded games are kept and how large a single recording may be. Recording itself happens in the game node and is never on the gameplay path; these settings only govern what is stored and for how long.',
        fields: {
            enabled: { type: 'boolean', label: 'Record replays for finished games', default: true },
            retentionDays: {
                type: 'number',
                label: 'Delete replays older than (days; 0 = keep forever)',
                min: 0,
                max: 3650,
                default: 0
            },
            maxCaptureKb: {
                type: 'number',
                label: 'Largest replay to store (KB) - bigger captures are skipped',
                min: 64,
                max: 20480,
                default: 2000
            },
            purgeIntervalHours: {
                type: 'number',
                label: 'Run the retention purge every N hours (0 = never)',
                min: 0,
                max: 168,
                default: 24
            },
            allowSharing: {
                type: 'boolean',
                label: 'Players may create public share links for their replays',
                default: true
            }
        }
    },
    watch: {
        title: 'Watch & Spectating',
        description:
            'The Watch hub. A broadcast delay holds the board back from spectators only - the two players always see the live position - so an event can be streamed without the stream leaking the position to anyone watching it.',
        fields: {
            showSpectatorCounts: {
                type: 'boolean',
                label: 'Show how many people are watching each game',
                default: true
            },
            broadcastDelaySeconds: {
                type: 'number',
                label: 'Hold the board back from spectators by (seconds; 0 = live)',
                min: 0,
                max: 600,
                default: 0
            },
            featuredGameId: {
                type: 'text',
                label: 'Featured game id (pinned to the top of Watch; empty = none)',
                maxLength: 64,
                default: ''
            },
            featuredLabel: {
                type: 'text',
                label: 'Featured game caption',
                maxLength: 120,
                default: ''
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
            'Replace the built-in About, Privacy and Terms pages with your own content (Markdown: # headings, **bold**, [links](url), - lists). Leave a field empty to keep the built-in page.',
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
            },
            termsMarkdown: {
                type: 'text',
                label: 'Terms of Service page (Markdown; empty = built-in page)',
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
    },
    // ARCHON (N7): the team ladder.
    teamRating: {
        title: 'Team Rating',
        description:
            "The separate ladder for teams. A team rating is never derived from its members' Amber - a roster is rated on what it does as a unit.",
        fields: {
            enabled: { type: 'boolean', label: 'Rate team events', default: true },
            defaultRating: {
                type: 'number',
                label: 'Starting team rating',
                min: 100,
                max: 4000,
                default: 1200
            },
            kFactor: {
                type: 'number',
                label: 'K-factor per event',
                min: 1,
                max: 200,
                default: 32
            },
            ratingFloor: {
                type: 'number',
                label: 'Team rating floor',
                min: 0,
                max: 2000,
                default: 100
            }
        }
    },
    // ARCHON (N13): whether paper games count.
    inPersonGames: {
        title: 'In-Person Games',
        description:
            'Paper games recorded by both players. A game is only ever committed when the two independent reports agree; rating it is a separate decision made here.',
        fields: {
            rated: {
                type: 'boolean',
                label: 'In-person games move Amber',
                // ARCHON: on by default, like every other kind of game here.
                // A committed paper game already needed two independent
                // reports that agree, inside the window, with both decks
                // attached - see InPersonGameService. Turn it off to run a
                // ladder that only counts games played on the platform.
                default: true
            },
            reportWindowDays: {
                type: 'number',
                label: 'Days a game stays open for reports',
                min: 1,
                max: 90,
                default: 7
            }
        }
    },
    // ARCHON (N5): moderation policy.
    moderation: {
        title: 'Moderation',
        description:
            'Reporting and sanction policy. Durations are defaults a moderator can override per action; every action always carries a reason.',
        fields: {
            minDetailLength: {
                type: 'number',
                label: 'Minimum characters in a report',
                min: 0,
                max: 500,
                // A player who has to write something has thought about it,
                // and empty reports are the bulk of a queue's noise.
                default: 10
            },
            defaultMuteHours: {
                type: 'number',
                label: 'Default mute length (hours)',
                min: 1,
                max: 8760,
                default: 24
            },
            defaultTimeoutHours: {
                type: 'number',
                label: 'Default timeout length (hours)',
                min: 1,
                max: 8760,
                default: 72
            },
            repeatWindowDays: {
                type: 'number',
                label: 'Repeat-report window (days)',
                min: 1,
                max: 365,
                default: 30
            },
            repeatThreshold: {
                type: 'number',
                label: 'Distinct reporters that flag an account as a pattern',
                min: 2,
                max: 50,
                default: 3
            }
        }
    },
    // ARCHON (N8): gradual rollout. Every flag defaults to the behaviour the
    // site already has, so an unset flag is never a behaviour change.
    features: {
        title: 'Feature Flags',
        description:
            'Turn features on or off at runtime. Flags apply across every lobby process within one refresh (immediately when Redis is available).',
        fields: {
            teams: { type: 'boolean', label: 'Teams and team events', default: true },
            inPersonGames: { type: 'boolean', label: 'In-person game tracking', default: true },
            clubLeaderboards: { type: 'boolean', label: 'Club leaderboards', default: true },
            adaptiveBo3: { type: 'boolean', label: 'Adaptive Bo3 events', default: true },
            hybridEvents: {
                type: 'boolean',
                label: 'Hybrid (paper + online) events',
                default: true
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
    } else if (descriptor.type === 'text') {
        if (typeof value !== 'string') {
            errors.push(`${path} must be text`);
        } else if (descriptor.maxLength !== undefined && value.length > descriptor.maxLength) {
            errors.push(`${path} must be at most ${descriptor.maxLength} characters`);
        }
    } else if (descriptor.type === 'select') {
        // One of a fixed list. Validated here rather than trusted from the
        // dropdown, because the settings API takes JSON from an admin's client
        // and a value outside the list would reach the code that switches on it.
        const allowed = (descriptor.options || []).map((option) => option.value);

        if (typeof value !== 'string' || !allowed.includes(value)) {
            errors.push(`${path} must be one of: ${allowed.join(', ')}`);
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
 * The code defaults for a section, built from the same field descriptors the
 * admin UI renders. Sections whose values come from a config file (rating,
 * dok) already merge their own defaults; this exists for sections that live
 * only in the registry, so a service reading them cannot drift from what the
 * admin panel says the default is.
 */
function sectionDefaults(section) {
    const definition = REGISTRY[section];

    if (!definition) {
        return {};
    }

    const walk = (fields) => {
        const result = {};

        for (const [key, descriptor] of Object.entries(fields)) {
            if (descriptor.type === 'section') {
                result[key] = walk(descriptor.fields);
            } else if (descriptor.default !== undefined) {
                result[key] = descriptor.default;
            }
        }

        return result;
    };

    return walk(definition.fields);
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

module.exports = { REGISTRY, validateSection, sectionDefaults };
