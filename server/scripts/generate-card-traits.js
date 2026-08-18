/*eslint no-console: 0*/

// ARCHON (N43): the card trait job - every card scored on AERC-style axes.
//
// The card priors (N38) gave each card ONE number. This job gives it a
// direction, on the axes Decks of KeyForge's AERC framework made the shared
// vocabulary of KeyForge card evaluation: expected amber, amber control,
// creature control, artifact control, efficiency, disruption. The taxonomy
// is DoK's; the scores are this platform's own (DoK's curated values live in
// their AGPL-licensed service and are not ours to import). The output feeds
// labFeatures' graded `card:ax:*` features via cardTraits.js.
//
//   ANTHROPIC_API_KEY=... npm run card-traits
//
//   --model <id>      model to score with (default claude-opus-5)
//   --chunk <n>       cards per batch request (default 15)
//   --limit <n>       stop after n unscored cards - a cheap smoke run
//   --force           rescore cards that already have scores
//   --resume <id>     skip submission and merge an existing batch's results
//   --dry-run         build everything, print the bill, submit nothing
//
// Same design as generate-card-priors.js and for the same reasons: Message
// Batches at half price, resumable by construction (merge + skip scored),
// the output a committed file reviewed like code.

const fs = require('fs');
const path = require('path');

const { getCardIndex } = require('../services/championschallenge/packCards');
const { TRAITS_FILE, AXES } = require('../services/championschallenge/cardTraits');

const POLL_MS = 30 * 1000;

const RUBRIC = [
    'You are an expert competitive KeyForge player scoring individual cards on',
    'the six axes below. Score each axis 0 to 4 (half points fine), where 0 is',
    '"contributes nothing on this axis" and 4 is "among the best in the game at',
    'this". Most cards score 0 on most axes - only score what the card actually',
    'does.',
    '',
    '  expectedAmber    amber this card typically nets its owner: pips plus',
    '                   reliable amber gain (1 ~= one amber over the game)',
    '  amberControl     removing or denying the OPPONENT amber: steal, capture',
    '                   to your own creatures, forcing amber loss, key cost',
    '                   increases at the moment they matter',
    '  creatureControl  removing, damaging, stunning or neutralizing enemy',
    '                   creatures',
    '  artifactControl  destroying or neutralizing enemy artifacts',
    '  efficiency       card advantage and deck velocity: drawing, archiving',
    '                   your own cards, replaying, thinning',
    '  disruption       degrading the opponent hand, draws or plans:',
    '                   discard from hand, purge, hand-size limits, skipping',
    '                   their steps',
    '',
    'Score every card exactly once, keyed by its id, using ids exactly as',
    'provided, with all six axes present per card (use 0 for none).'
].join('\n');

const TRAITS_SCHEMA = {
    type: 'object',
    properties: {
        scores: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    expectedAmber: { type: 'number' },
                    amberControl: { type: 'number' },
                    creatureControl: { type: 'number' },
                    artifactControl: { type: 'number' },
                    efficiency: { type: 'number' },
                    disruption: { type: 'number' }
                },
                required: ['id', ...AXES],
                additionalProperties: false
            }
        }
    },
    required: ['scores'],
    additionalProperties: false
};

function parseArgs(argv) {
    const args = {
        model: 'claude-opus-5',
        chunk: 15,
        limit: 0,
        force: false,
        resume: null,
        dryRun: false
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];

        if (arg === '--model') {
            args.model = argv[++i];
        } else if (arg === '--chunk') {
            args.chunk = Math.max(1, parseInt(argv[++i], 10) || 15);
        } else if (arg === '--limit') {
            args.limit = Math.max(0, parseInt(argv[++i], 10) || 0);
        } else if (arg === '--force') {
            args.force = true;
        } else if (arg === '--resume') {
            args.resume = argv[++i];
        } else if (arg === '--dry-run') {
            args.dryRun = true;
        } else {
            console.error(`Unknown argument: ${arg}`);
            process.exit(2);
        }
    }

    return args;
}

/** One card, as a compact line the model can judge from. */
function describeCard(card) {
    const parts = [
        `id: ${card.id}`,
        `name: ${card.name}`,
        `${card.house || 'houseless'} ${card.type || 'card'}`
    ];

    if (typeof card.amber === 'number' && card.amber > 0) {
        parts.push(`amber pips: ${card.amber}`);
    }

    if (card.power !== null && card.power !== undefined) {
        parts.push(`power: ${card.power}`);
    }

    if (card.armor) {
        parts.push(`armor: ${card.armor}`);
    }

    if (card.keywords && card.keywords.length) {
        parts.push(`keywords: ${card.keywords.join(', ')}`);
    }

    const text = String(card.text || '')
        .replace(/\s+/g, ' ')
        .trim();

    parts.push(`text: ${text || '(no text)'}`);

    return parts.join(' | ');
}

function chunkRequests(cards, chunkSize, model) {
    const requests = [];

    for (let start = 0; start < cards.length; start += chunkSize) {
        const slice = cards.slice(start, start + chunkSize);
        const prompt =
            `Score these ${slice.length} KeyForge cards on the six axes:\n\n` +
            slice.map(describeCard).join('\n');

        requests.push({
            custom_id: `chunk-${requests.length}`,
            ids: slice.map((card) => card.id),
            params: {
                model,
                max_tokens: 12000,
                system: RUBRIC,
                messages: [{ role: 'user', content: prompt }],
                output_config: { format: { type: 'json_schema', schema: TRAITS_SCHEMA } }
            }
        });
    }

    return requests;
}

function readTraitsFile() {
    try {
        if (fs.existsSync(TRAITS_FILE)) {
            const raw = fs.readFileSync(TRAITS_FILE, 'utf8');

            // An empty file is what an interrupted copy leaves behind; a
            // NON-empty file that will not parse could hold paid-for scores
            // and stops the run.
            if (!raw.trim()) {
                return { version: 1, scores: {} };
            }

            const parsed = JSON.parse(raw);

            if (parsed && parsed.scores && typeof parsed.scores === 'object') {
                return parsed;
            }
        }
    } catch (err) {
        console.error(`Could not read ${TRAITS_FILE}: ${err.message}`);
        process.exit(1);
    }

    return { version: 1, scores: {} };
}

function writeTraitsFile(scores, model) {
    const sorted = {};

    for (const id of Object.keys(scores).sort()) {
        sorted[id] = scores[id];
    }

    const out = {
        version: 1,
        model,
        generatedAt: new Date().toISOString(),
        scoreScale: '0-4 per axis, AERC-style taxonomy; mapped to features by cardTraits.js',
        axes: AXES,
        scores: sorted
    };

    fs.mkdirSync(path.dirname(TRAITS_FILE), { recursive: true });
    fs.writeFileSync(TRAITS_FILE, JSON.stringify(out, null, 2) + '\n');
}

/** The message's text content, JSON-parsed, tolerating a fenced block. */
function parseScores(message) {
    const text = (message.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
    const bare = text.replace(/^\s*```(?:json)?/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(bare);

    return Array.isArray(parsed.scores) ? parsed.scores : [];
}

const clampAxis = (value) => Math.max(0, Math.min(4, Number(value) || 0));

async function collectResults(client, batchId, requestIndex, scores) {
    const failures = [];
    let succeeded = 0;

    for await (const result of await client.messages.batches.results(batchId)) {
        const request = requestIndex.get(result.custom_id);

        if (!request) {
            continue;
        }

        if (result.result.type !== 'succeeded') {
            failures.push(`${result.custom_id}: ${result.result.type}`);
            continue;
        }

        const message = result.result.message;

        if (message.stop_reason === 'refusal' || message.stop_reason === 'max_tokens') {
            failures.push(`${result.custom_id}: stop_reason ${message.stop_reason}`);
            continue;
        }

        let entries;

        try {
            entries = parseScores(message);
        } catch (err) {
            failures.push(`${result.custom_id}: unparseable JSON (${err.message})`);
            continue;
        }

        const wanted = new Set(request.ids);

        for (const entry of entries) {
            if (!wanted.has(entry.id)) {
                continue;
            }

            const card = {};

            for (const axis of AXES) {
                card[axis] = clampAxis(entry[axis]);
            }

            scores[entry.id] = card;
            wanted.delete(entry.id);
        }

        for (const id of wanted) {
            failures.push(`${result.custom_id}: no scores returned for ${id}`);
        }

        succeeded++;
    }

    return { succeeded, failures };
}

async function main() {
    const args = parseArgs(process.argv);
    const index = getCardIndex();
    const existing = readTraitsFile();
    const already = new Set(args.force ? [] : Object.keys(existing.scores));
    let cards = Object.values(index)
        .filter((card) => card && card.id && !already.has(card.id))
        .sort((a, b) => a.id.localeCompare(b.id));

    if (args.limit > 0) {
        cards = cards.slice(0, args.limit);
    }

    console.log(
        `${Object.keys(index).length} cards in the pool, ` +
            `${already.size} already scored, ${cards.length} to score.`
    );

    if (!cards.length && !args.resume) {
        console.log('Nothing to do.');

        return;
    }

    const requests = chunkRequests(cards, args.chunk, args.model);
    const requestIndex = new Map(requests.map((request) => [request.custom_id, request]));

    if (args.dryRun) {
        const inputChars = requests.reduce(
            (sum, request) => sum + RUBRIC.length + request.params.messages[0].content.length,
            0
        );

        console.log(`Would submit ${requests.length} batch requests of ~${args.chunk} cards.`);
        console.log(`~${Math.round(inputChars / 4 / 1000)}k input tokens plus thinking/output.`);

        if (args.model === 'claude-opus-5') {
            const dollars = (inputChars / 4 / 1e6) * 2.5 + ((requests.length * 2200) / 1e6) * 12.5;

            console.log(`Rough cost at Claude Opus 5 batch rates: ~$${dollars.toFixed(2)}`);
        }

        return;
    }

    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        console.error(
            'No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment. ' +
                'Set one, or use --dry-run to see what would be submitted.'
        );
        process.exit(1);
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();
    let batchId = args.resume;

    if (!batchId) {
        const batch = await client.messages.batches.create({
            requests: requests.map(({ custom_id, params }) => ({ custom_id, params }))
        });

        batchId = batch.id;
        console.log(`Submitted batch ${batchId} (${requests.length} requests).`);
        console.log(`If this run is interrupted: --resume ${batchId}`);
    } else {
        console.log(`Resuming batch ${batchId}.`);
    }

    const startedAt = Date.now();
    let batch;

    for (;;) {
        batch = await client.messages.batches.retrieve(batchId);

        if (batch.processing_status === 'ended') {
            break;
        }

        const counts = batch.request_counts;

        console.log(
            `[${Math.round((Date.now() - startedAt) / 1000)}s] ` +
                `processing: ${counts.processing}, succeeded: ${counts.succeeded}, ` +
                `errored: ${counts.errored}`
        );
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }

    const scores = { ...existing.scores };
    const { succeeded, failures } = await collectResults(client, batchId, requestIndex, scores);

    writeTraitsFile(scores, args.model);

    const nameOf = (id) => (index[id] && index[id].name) || id;
    const top = (axis) =>
        Object.entries(scores)
            .sort((a, b) => (b[1][axis] || 0) - (a[1][axis] || 0))
            .slice(0, 5)
            .map(([id, card]) => `  ${card[axis].toFixed(1)}  ${nameOf(id)}`)
            .join('\n');

    console.log(`\n${succeeded} chunks succeeded; ${Object.keys(scores).length} cards scored.`);
    console.log(`Wrote ${TRAITS_FILE}\n`);

    for (const axis of AXES) {
        console.log(`Top ${axis}:\n${top(axis)}\n`);
    }

    if (failures.length) {
        console.error(
            `\n${failures.length} problems (rerun the script to fill the gaps):\n  ` +
                failures.slice(0, 20).join('\n  ') +
                (failures.length > 20 ? `\n  ...and ${failures.length - 20} more` : '')
        );
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
