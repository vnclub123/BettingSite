import jwt from 'jsonwebtoken';
import cookie from 'cookie';
import { connectDB, User, Round, Bet } from './utils/db.js';
import { getColor, getSize } from './utils/game-helpers.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}

const SITE_URL = process.env.URL || process.env.DEPLOY_URL || 'http://localhost:5173';

const headers = {
    'Access-Control-Allow-Origin': SITE_URL,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
};

// No-cache headers for dynamic game state (GET /current)
// Must NEVER be cached by CDN or browser to prevent timer jitter and delayed results
const noCacheHeaders = {
    ...headers,
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
};

// Helper to get current round ID
function getCurrentRoundId() {
    return Math.floor(Date.now() / 60000);
}

// Helper to get time left in current round
function getTimeLeft() {
    return 60 - (Math.floor(Date.now() / 1000) % 60);
}


export const handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    await connectDB();

    const path = event.path.replace('/.netlify/functions/game', '');

    try {
        // GET /current - Get current round info
        if (event.httpMethod === 'GET' && path === '/current') {
            const now = Date.now();
            const currentRoundId = Math.floor(now / 60000);
            const timeLeft = 60 - (Math.floor(now / 1000) % 60);

            // Get last 20 results (excluding the active round if already generated/set)
            const lastResults = await Round.find({
                roundId: { $lt: currentRoundId },
                result: { $ne: null }
            })
                .sort({ roundId: -1 })
                .limit(20)
                .select('roundId result color size')
                .lean();

            return {
                statusCode: 200,
                headers: noCacheHeaders,
                body: JSON.stringify({
                    roundId: currentRoundId,
                    timeLeft,
                    serverTime: now,
                    lastResults: lastResults.map(r => ({
                        roundId: r.roundId,
                        result: r.result,
                        color: r.color,
                        size: r.size,
                    })),
                }),
            };
        }

        // POST /bet - Place a bet
        if (event.httpMethod === 'POST' && path === '/bet') {
            // Verify JWT
            const cookies = cookie.parse(event.headers.cookie || '');
            const token = cookies.token;

            if (!token) {
                return {
                    statusCode: 401,
                    headers,
                    body: JSON.stringify({ error: 'Not authenticated' }),
                };
            }

            // Parse body first — fails immediately on bad input, before any DB work
            let betType, betValue, amount;
            try { ({ betType, betValue, amount } = JSON.parse(event.body || '{}')); }
            catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) }; }

            // Validate inputs before touching the database at all
            if (!betType || !amount || amount <= 0) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bet' }) };
            }
            const validBetTypes = ['green', 'red', 'violet', 'big', 'small', 'number'];
            if (!validBetTypes.includes(betType)) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid bet type' }) };
            }
            if (betType === 'number' && (betValue < 0 || betValue > 9)) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid number' }) };
            }

            // Time check — fail fast before any DB call
            const currentRoundId = getCurrentRoundId();
            const timeLeft = getTimeLeft();
            if (timeLeft <= 15) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Betting closed - less than 15 seconds remaining' }) };
            }

            const decoded = jwt.verify(token, JWT_SECRET);

            // Run user fetch + round check in parallel — saves ~100ms per bet
            const [user, existingRound] = await Promise.all([
                User.findById(decoded.userId).select('balance bankDetails'),
                Round.findOne({ roundId: currentRoundId }, { result: 1 }).lean(),
            ]);

            if (!user) {
                return { statusCode: 401, headers, body: JSON.stringify({ error: 'User not found' }) };
            }
            if (existingRound && existingRound.result !== null && existingRound.result !== undefined) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Round has ended' }) };
            }

            // Balance check
            if (amount > user.balance) {
                return { statusCode: 400, headers, body: JSON.stringify({ error: 'Insufficient balance' }) };
            }

            // Deduct balance atomically then create bet.
            // If Bet.create fails, we refund the user so money is never lost.
            await User.findByIdAndUpdate(user._id, { $inc: { balance: -amount } });

            try {
                await Bet.create({
                    userId: user._id,
                    roundId: currentRoundId,
                    betType,
                    betValue: betType === 'number' ? betValue : null,
                    amount,
                });
            } catch (betErr) {
                // Refund — bet record failed to create, restore balance
                await User.findByIdAndUpdate(user._id, { $inc: { balance: amount } });
                console.error('Bet.create failed, refunded user:', betErr);
                return {
                    statusCode: 500,
                    headers,
                    body: JSON.stringify({ error: 'Failed to place bet, amount refunded' }),
                };
            }

            // Fetch fresh balance to return accurate value
            const updatedUser = await User.findById(user._id).select('balance').lean();

            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    success: true,
                    balance: updatedUser.balance,
                }),
            };
        }

        return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Not found' }),
        };
    } catch (error) {
        console.error('Game error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' }),
        };
    }
};
