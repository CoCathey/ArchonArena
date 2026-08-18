/*eslint no-console: 0*/

// ARCHON (N38): the one-time card reading job.
//
// The challenge bot's learned model cannot read a card's text - every per-card
// weight starts at zero and earns its meaning over ~20 sightings. This script
// closes the cold start from the other end: a language model reads every
// card's PRINTED text once and scores its competitive impact 0-10, and those
// scores become the priors shrinkage shrinks toward (see
// services/championschallenge/cardPriors.js).
//
//   ANTHROPIC_API_KEY=... npm run card-priors
//
//   --model <id>      model to score with (default claude-opus-5)
//   --chunk <n>       cards per batch request (default 20)
//   --limit <n>       stop after n unscored cards - a cheap smoke run
//   --force           rescore cards that already have a score
//   --resume <id>     skip submission and merge an existing batch's results
//   --dry-run         build everything, print the bill, submit nothing
//
// Design decisions that matter:
//
//  - **The Message Batches API**, because nothing here is latency-sensitive
//    and batches run at half price. The whole card pool is a few dollars,
//    once.
//  - **Resumable by construction.** Scores merge into the existing file and
//    already-scored cards are skipped, so an interrupted run costs only its
//    own chunks, and a new set releases costs only the new cards. `--resume`
//    picks up a submitted batch whose poll was interrupted.
//  - **The output is a committed file, not a service.** Runtime never calls
//    an API and needs no key; review the diff like code (top and bottom
//    scores print at the end precisely so a human can laugh at them before
//    committing).

const fs = require('fs');
const path = require('path');

const { getCardIndex } = require('../services/championschallenge/packCards');
const { PRIORS_FILE } = require('../services/championschallenge/cardPriors');

const POLL_MS = 30 * 1000;

const RUBRIC = [
    'You are an expert competitive KeyForge player rating individual cards.',
    'For each card provided, rate its overall competitive impact from 0 to 10,',
    'judged across typical decks that contain it and against the entire card pool:',
    '',
    '  0-1  a liability or near-dead card you regret drawing',
    '  2-4  below average; playable but weak',
    '  5    exactly average filler',
    '  6-8  above average; a card that regularly earns tempo, amber or board',
    '  9-10 a bomb that can swing or win games on its own',
    '',
    'Weigh what wins KeyForge games: amber pips and amber generation, stealing',
    'and capture, key cost control, board presence and removal, card advantage,',
    'flexibility, and how reliably the effect matters. Efficient repeatable',
    'value beats situational splash. Half points like 6.5 are fine.',
    '',
    'Score every card you are given exactly once, keyed by its id, using the',
    'ids exactly as provided.'
].join('\n');

const SCORES_SCHEMA = {
    type: 'object',
    properties: {
        scores: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    score: { type: 'number' }
                },
                required: ['id', 'score'],
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
        chunk: 20,
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
            args.chunk = Math.max(1, parseInt(argv[++i], 10) || 20);
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
        `${card.house || 'houseless'} ${card.type || 'card'} (${card.rarity || 'Common'})`
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

    if (card.traits && card.traits.length) {
        parts.push(`traits: ${card.traits.join(', ')}`);
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
            `Rate these ${slice.length} KeyForge cards:\n\n` + slice.map(describeCard).join('\n');

        requests.push({
            custom_id: `chunk-${requests.length}`,
            ids: slice.map((card) => card.id),
            params: {
                model,
                max_tokens: 8000,
                system: RUBRIC,
                messages: [{ role: 'user', content: prompt }],
                output_config: { format: { type: 'json_schema', schema: SCORES_SCHEMA } }
            }
        });
    }

    return requests;
}

function readPriorsFile() {
    try {
        if (fs.existsSync(PRIORS_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(PRIORS_FILE, 'utf8'));

            if (parsed && parsed.scores && typeof parsed.scores === 'object') {
                return parsed;
            }
        }
    } catch (err) {
        console.error(`Could not read ${PRIORS_FILE}: ${err.message}`);
        process.exit(1);
    }

    return { version: 1, scores: {} };
}

function writePriorsFile(existing, scores, model) {
    // Keys sorted so regeneration diffs like code.
    const sorted = {};

    for (const id of Object.keys(scores).sort()) {
        sorted[id] = scores[id];
    }

    const out = {
        version: 1,
        model,
        generatedAt: new Date().toISOString(),
        scoreScale: '0-10, 5 = average; mapped to logit priors by cardPriors.js',
        scores: sorted
    };

    fs.mkdirSync(path.dirname(PRIORS_FILE), { recursive: true });
    fs.writeFileSync(PRIORS_FILE, JSON.stringify(out, null, 2) + '\n');

    return out;
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
            // Only ids this chunk actually asked about: a model that invents
            // an id must not write a stranger's prior.
            if (wanted.has(entry.id) && Number.isFinite(entry.score)) {
                scores[entry.id] = Math.max(0, Math.min(10, entry.score));
                wanted.delete(entry.id);
            }
        }

        for (const id of wanted) {
            failures.push(`${result.custom_id}: no score returned for ${id}`);
        }

        succeeded++;
    }

    return { succeeded, failures };
}

async function main() {
    const args = parseArgs(process.argv);
    const index = getCardIndex();
    const existing = readPriorsFile();
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
            // Very rough: input at $2.50/M batched, ~700 thinking+output
            // tokens per request at $12.50/M batched.
            const dollars = (inputChars / 4 / 1e6) * 2.5 + ((requests.length * 700) / 1e6) * 12.5;

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

    writePriorsFile(existing, scores, args.model);

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const nameOf = (id) => (index[id] && index[id].name) || id;
    const show = (entries) =>
        entries.map(([id, score]) => `  ${score.toFixed(1)}  ${nameOf(id)} (${id})`).join('\n');

    console.log(`\n${succeeded} chunks succeeded; ${Object.keys(scores).length} cards scored.`);
    console.log(`Wrote ${PRIORS_FILE}\n`);
    console.log(`Highest rated:\n${show(ranked.slice(0, 15))}\n`);
    console.log(`Lowest rated:\n${show(ranked.slice(-15).reverse())}`);

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
