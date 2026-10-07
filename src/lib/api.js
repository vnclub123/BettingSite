const API_BASE = '/.netlify/functions';

export const api = {
    // Auth
    register: async (phone, password) => {
        const res = await fetch(`${API_BASE}/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ phone, password }),
        });
        return res.json();
    },

    login: async (phone, password) => {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ phone, password }),
        });
        return res.json();
    },

    getMe: async () => {
        const res = await fetch(`${API_BASE}/auth/me`, {
            credentials: 'include',
        });
        return res.json();
    },

    logout: async () => {
        const res = await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
        });
        return res.json();
    },

    // Game
    getCurrentRound: async () => {
        const res = await fetch(`${API_BASE}/game/current`, {
            cache: 'no-store',
        });
        return res.json();
    },

    placeBet: async (betType, betValue, amount, timeLeft = 60) => {
        // Smart jitter: spread load when time is plentiful, fire instantly near the cutoff.
        //
        //  timeLeft > 25s  → full 400ms jitter (safe, bet won't miss cutoff)
        //  timeLeft 20–25s → 200ms jitter (cautious)
        //  timeLeft ≤ 20s  → 0ms jitter   (fire immediately — don't risk missing the 15s cutoff)
        //
        // Without this, a player betting at 15.3s remaining + 400ms jitter
        // = request arrives at 14.9s → server rejects it. Player loses their click.
        let maxJitter = 0;
        if (timeLeft > 25) maxJitter = 400;
        else if (timeLeft > 20) maxJitter = 200;
        // else 0 — fire immediately

        if (maxJitter > 0) {
            await new Promise(r => setTimeout(r, Math.random() * maxJitter));
        }

        // Retry with exponential backoff — but NOT for business-logic rejections.
        // Only retry on server overload (429/503) or network failures.
        const MAX_RETRIES = 3;
        let lastError;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                const res = await fetch(`${API_BASE}/game/bet`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ betType, betValue, amount }),
                });

                const data = await res.json();

                // Don't retry on business-logic rejections — they won't change on retry
                // e.g. "Betting closed", "Insufficient balance", "Round has ended"
                if (res.status === 400 || res.status === 401) {
                    return data;
                }

                // Retryable: server overloaded — wait and try again
                if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
                    const backoff = 600 * attempt; // 600ms, 1200ms
                    await new Promise(r => setTimeout(r, backoff));
                    continue;
                }

                return data;
            } catch (err) {
                // Network failure — retry
                lastError = err;
                if (attempt < MAX_RETRIES) {
                    await new Promise(r => setTimeout(r, 600 * attempt));
                }
            }
        }

        throw lastError || new Error('Failed to place bet after retries');
    },

    // Bets
    submitRecharge: async (amount, transactionId) => {
        const res = await fetch(`${API_BASE}/bets/recharge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ amount, transactionId }),
        });
        return res.json();
    },

    submitWithdrawal: async (amount) => {
        const res = await fetch(`${API_BASE}/bets/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ amount }),
        });
        return res.json();
    },

    saveBankDetails: async (accountNumber, ifsc, accountHolder) => {
        const res = await fetch(`${API_BASE}/bets/save-bank`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ accountNumber, ifsc, accountHolder }),
        });
        return res.json();
    },

    getBetHistory: async () => {
        const res = await fetch(`${API_BASE}/bets/history`, {
            credentials: 'include',
        });
        return res.json();
    },

    getTransactions: async () => {
        const res = await fetch(`${API_BASE}/bets/transactions`, {
            credentials: 'include',
        });
        return res.json();
    },

    // Admin
    adminLogin: async (phone, password) => {
        const res = await fetch(`${API_BASE}/admin/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ phone, password }),
        });
        return res.json();
    },

    setResult: async (result) => {
        const res = await fetch(`${API_BASE}/admin/set-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ result }),
        });
        return res.json();
    },

    getUsers: async (search = '') => {
        const res = await fetch(`${API_BASE}/admin/users?search=${search}`, {
            credentials: 'include',
        });
        return res.json();
    },

    updateBalance: async (userId, amount) => {
        const res = await fetch(`${API_BASE}/admin/update-balance`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ userId, amount }),
        });
        return res.json();
    },

    getRecharges: async () => {
        const res = await fetch(`${API_BASE}/admin/recharges`, {
            credentials: 'include',
        });
        return res.json();
    },

    approveRecharge: async (requestId, approve) => {
        const res = await fetch(`${API_BASE}/admin/approve-recharge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ requestId, approve }),
        });
        return res.json();
    },

    getWithdrawals: async () => {
        const res = await fetch(`${API_BASE}/admin/withdrawals`, {
            credentials: 'include',
        });
        return res.json();
    },

    approveWithdrawal: async (requestId, approve) => {
        const res = await fetch(`${API_BASE}/admin/approve-withdrawal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ requestId, approve }),
        });
        return res.json();
    },

    getCurrentBets: async () => {
        const res = await fetch(`${API_BASE}/admin/bets`, {
            credentials: 'include',
        });
        return res.json();
    },

    updateUPI: async (upiId, qrImage) => {
        const res = await fetch(`${API_BASE}/admin/update-upi`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ upiId, qrImage }),
        });
        return res.json();
    },

    getUPI: async () => {
        const res = await fetch(`${API_BASE}/admin/upi`, {
            credentials: 'include',
        });
        return res.json();
    },

    getRoundBets: async (roundId) => {
        const res = await fetch(`${API_BASE}/bets/round-bets?roundId=${roundId}`, {
            credentials: 'include',
        });
        return res.json();
    },

    // Notifications
    getNotifications: async () => {
        const res = await fetch(`${API_BASE}/notifications`, {
            credentials: 'include',
        });
        return res.json();
    },

    dismissNotification: async (id) => {
        const res = await fetch(`${API_BASE}/notifications/dismiss/${id}`, {
            method: 'POST',
            credentials: 'include',
        });
        return res.json();
    },

    createNotification: async (message, targetUserPhone) => {
        const res = await fetch(`${API_BASE}/admin/create-notification`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ message, targetUserPhone }),
        });
        return res.json();
    },

    getAdminNotifications: async () => {
        const res = await fetch(`${API_BASE}/admin/notifications`, {
            credentials: 'include',
        });
        return res.json();
    },
};
