import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';

export default function Game() {
    const [user, setUser] = useState(null);
    const [roundId, setRoundId] = useState(0);
    const [timeLeft, setTimeLeft] = useState(60);
    const [lastResults, setLastResults] = useState([]);
    const [betType, setBetType] = useState('');
    const [betValue, setBetValue] = useState(null);
    const [amount, setAmount] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [loading, setLoading] = useState(false);
    const [showResultPopup, setShowResultPopup] = useState(false);
    const [lastRoundResult, setLastRoundResult] = useState(null);
    const [userRoundBets, setUserRoundBets] = useState([]);
    const [notifications, setNotifications] = useState([]);
    const navigate = useNavigate();

    // Refs to track state smoothly without skips or lag
    const lastShownRoundIdRef = useRef(null);
    const fetchTimeoutRef = useRef(null);
    const tickIntervalRef = useRef(null);
    const serverOffsetMsRef = useRef(null);

    // Calculate exact time left in current round based on synchronized clock
    const getCalculatedTimeLeft = () => {
        const offsetMs = serverOffsetMsRef.current !== null ? serverOffsetMsRef.current : 0;
        const now = Date.now() + offsetMs;
        const secondsInRound = Math.floor(now / 1000) % 60;
        return 60 - secondsInRound;
    };

    const scheduleNextFetch = (delay) => {
        if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
        fetchTimeoutRef.current = setTimeout(async () => {
            await fetchGameData();
        }, delay);
    };

    useEffect(() => {
        fetchUser();
        fetchNotifications();

        // Initial immediate time set
        setTimeLeft(getCalculatedTimeLeft());

        // Initial game data fetch
        fetchGameData();

        // Smooth client-side countdown tick every 1 second (continuous, drift-free)
        tickIntervalRef.current = setInterval(() => {
            setTimeLeft(getCalculatedTimeLeft());
        }, 1000);

        return () => {
            if (fetchTimeoutRef.current) clearTimeout(fetchTimeoutRef.current);
            clearInterval(tickIntervalRef.current);
        };
    }, []);

    const fetchNotifications = async () => {
        try {
            const data = await api.getNotifications();
            if (!data.error) {
                setNotifications(data.notifications || []);
            }
        } catch (err) {
            console.error('Failed to load notifications');
        }
    };

    const fetchUser = async () => {
        const data = await api.getMe();
        if (data.error) {
            navigate('/login');
        } else {
            setUser(data.user);
        }
    };

    const fetchGameData = async () => {
        try {
            const fetchStartTime = Date.now();
            const data = await api.getCurrentRound();
            const fetchEndTime = Date.now();

            if (!data.roundId) {
                scheduleNextFetch(5000);
                return;
            }

            // Sync server offset accurately using serverTime or timeLeft
            let estimatedServerNow;
            if (typeof data.serverTime === 'number') {
                const latency = Math.max(0, (fetchEndTime - fetchStartTime) / 2);
                estimatedServerNow = data.serverTime + latency;
            } else if (typeof data.timeLeft === 'number') {
                const roundStart = Math.floor(fetchEndTime / 60000) * 60000;
                estimatedServerNow = roundStart + (60 - data.timeLeft) * 1000;
            }

            if (estimatedServerNow !== undefined) {
                const measuredOffsetMs = estimatedServerNow - fetchEndTime;
                // Initialize on first load, or update only if real clock drift exceeds 3 seconds
                if (serverOffsetMsRef.current === null || Math.abs(serverOffsetMsRef.current - measuredOffsetMs) > 3000) {
                    serverOffsetMsRef.current = measuredOffsetMs;
                }
            }

            // Update timer state
            setTimeLeft(getCalculatedTimeLeft());

            // Initialize lastShownRoundIdRef to the previous round on first load
            if (lastShownRoundIdRef.current === null) {
                lastShownRoundIdRef.current = data.roundId - 1;
            }

            // Check if there is a new result that we haven't shown a popup for yet
            const latestResult = data.lastResults && data.lastResults.length > 0 ? data.lastResults[0] : null;
            if (latestResult && latestResult.roundId > lastShownRoundIdRef.current) {
                // Ensure the result is for a round that has already ended relative to the server
                if (latestResult.roundId < data.roundId) {
                    lastShownRoundIdRef.current = latestResult.roundId;

                    // Fetch user's bets for this completed round and trigger the popup
                    const betsData = await api.getRoundBets(latestResult.roundId);
                    setUserRoundBets(betsData.bets || []);
                    setLastRoundResult(latestResult);
                    setShowResultPopup(true);
                    
                    // Refresh user balance
                    fetchUser();
                }
            }

            setRoundId(data.roundId);
            setLastResults(data.lastResults || []);

            // Decide next fetch delay based on current real-time progress:
            // Fast poll (1s) in 3 windows:
            //  1. Last 8 seconds of a round — catches result the moment it lands
            //  2. First 5 seconds of a new round — catches late-arriving result instantly
            //  3. Any time we're still waiting for a result from a previous round
            const currentTimeLeft = getCalculatedTimeLeft();
            const isNewRound = currentTimeLeft > 55;           // round just flipped
            const isEndOfRound = currentTimeLeft <= 8;          // about to end
            const isWaitingForResult = latestResult === null || latestResult.roundId < (data.roundId - 1);

            if (isEndOfRound || isNewRound || isWaitingForResult) {
                scheduleNextFetch(1000);
            } else {
                scheduleNextFetch(5000);
            }
        } catch (err) {
            console.error('Failed to fetch game data');
            scheduleNextFetch(5000);
        }
    };

    const handleBet = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        setLoading(true);

        try {
            const data = await api.placeBet(betType, betValue, parseFloat(amount), timeLeft);
            if (data.error) {
                setError(data.error);
            } else {
                setSuccess('Bet placed successfully!');
                setUser({ ...user, balance: data.balance });
                setAmount('');
                setBetType('');
                setBetValue(null);
                // Clear success after 3s
                setTimeout(() => setSuccess(''), 3000);
            }
        } catch (err) {
            setError('Failed to place bet');
        } finally {
            setLoading(false);
        }
    };

    const closePopup = () => {
        setShowResultPopup(false);
        setLastRoundResult(null);
        setUserRoundBets([]);
    };

    // Calculate total profit/loss from user's bets
    const calculateProfitLoss = () => {
        let totalBetAmount = 0;
        let totalPayout = 0;

        userRoundBets.forEach(bet => {
            totalBetAmount += bet.amount;
            if (bet.won) {
                totalPayout += bet.payout;
            }
        });

        return {
            totalBetAmount,
            totalPayout,
            profitLoss: totalPayout - totalBetAmount,
            hasWon: totalPayout > 0
        };
    };

    const handleDismissNotification = async (id) => {
        try {
            await api.dismissNotification(id);
            setNotifications(notifications.filter(n => n._id !== id));
        } catch (err) {
            console.error('Failed to dismiss notification');
        }
    };

    // Timer color changes based on urgency
    const timerColor = timeLeft <= 10 ? '#ef4444' : timeLeft <= 20 ? '#f59e0b' : '#ffffff';

    if (!user) return (
        <div className="min-h-screen bg-gray-900 flex items-center justify-center">
            <div className="text-center">
                <div className="w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                <p className="text-white text-lg">Loading...</p>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 p-4">
            {/* Result Popup */}
            {showResultPopup && lastRoundResult && (() => {
                const { totalBetAmount, totalPayout, profitLoss, hasWon } = calculateProfitLoss();
                const hasBets = userRoundBets.length > 0;

                return (
                    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50" onClick={closePopup}>
                        <div className="bg-white rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                            <h2 className="text-3xl font-bold text-center mb-6 text-gray-800">Round Result</h2>

                            <div className="text-center mb-6">
                                <div className="text-6xl font-bold mb-4" style={{ color: lastRoundResult.color === 'green' ? '#10b981' : lastRoundResult.color === 'red' ? '#ef4444' : '#8b5cf6' }}>
                                    {lastRoundResult.result}
                                </div>
                                <div className="flex justify-center gap-4 mb-4">
                                    <span className="px-4 py-2 rounded-full text-white font-semibold" style={{ backgroundColor: lastRoundResult.color === 'green' ? '#10b981' : lastRoundResult.color === 'red' ? '#ef4444' : '#8b5cf6' }}>
                                        {lastRoundResult.color.toUpperCase()}
                                    </span>
                                    <span className="px-4 py-2 rounded-full bg-gray-700 text-white font-semibold">
                                        {lastRoundResult.size.toUpperCase()}
                                    </span>
                                </div>
                                <p className="text-gray-600 mb-4">Round #{lastRoundResult.roundId}</p>
                            </div>

                            {/* Win/Loss Information */}
                            {hasBets && (
                                <div className="mb-6">
                                    <div className={`p-4 rounded-lg mb-4 ${hasWon ? 'bg-green-50 border-2 border-green-500' : 'bg-red-50 border-2 border-red-500'}`}>
                                        <div className="text-center">
                                            <p className={`text-2xl font-bold mb-2 ${hasWon ? 'text-green-600' : 'text-red-600'}`}>
                                                {hasWon ? '🎉 You Won!' : '😔 You Lost'}
                                            </p>
                                            <p className={`text-3xl font-bold ${hasWon ? 'text-green-700' : 'text-red-700'}`}>
                                                {profitLoss >= 0 ? '+' : ''}₹{profitLoss.toFixed(2)}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="bg-gray-50 p-4 rounded-lg">
                                        <div className="flex justify-between mb-2">
                                            <span className="text-gray-600">Total Bet:</span>
                                            <span className="font-semibold">₹{totalBetAmount.toFixed(2)}</span>
                                        </div>
                                        {hasWon && (
                                            <div className="flex justify-between mb-2">
                                                <span className="text-gray-600">Total Payout:</span>
                                                <span className="font-semibold text-green-600">₹{totalPayout.toFixed(2)}</span>
                                            </div>
                                        )}
                                        <div className="border-t pt-2 mt-2">
                                            <p className="text-sm text-gray-500 mb-2">Your Bets:</p>
                                            {userRoundBets.map((bet, idx) => (
                                                <div key={idx} className="flex justify-between text-sm mb-1">
                                                    <span className={bet.won ? 'text-green-600 font-semibold' : 'text-gray-600'}>
                                                        {bet.betType === 'number' ? `Number ${bet.betValue}` : bet.betType.toUpperCase()}
                                                    </span>
                                                    <span className={bet.won ? 'text-green-600 font-semibold' : 'text-gray-600'}>
                                                        ₹{bet.amount.toFixed(2)} {bet.won ? `→ ₹${bet.payout.toFixed(2)}` : ''}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {!hasBets && (
                                <div className="mb-6 p-4 bg-gray-50 rounded-lg text-center">
                                    <p className="text-gray-600">You didn't place any bets this round</p>
                                </div>
                            )}

                            <button
                                onClick={closePopup}
                                className="w-full bg-gradient-to-r from-purple-600 to-blue-600 text-white py-3 rounded-lg font-semibold hover:from-purple-700 hover:to-blue-700 transition"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                );
            })()}

            <div className="max-w-6xl mx-auto">
                {/* Notifications */}
                {notifications.length > 0 && (
                    <div className="space-y-2 mb-4">
                        {notifications.map((notification) => (
                            <div key={notification._id} className="bg-yellow-500 bg-opacity-90 backdrop-blur-lg rounded-lg p-4 shadow-xl flex items-start justify-between">
                                <div className="flex items-start gap-3 flex-1">
                                    <span className="text-2xl">📢</span>
                                    <p className="text-white font-medium">{notification.message}</p>
                                </div>
                                <button
                                    onClick={() => handleDismissNotification(notification._id)}
                                    className="text-white hover:text-gray-200 font-bold text-xl ml-4"
                                >
                                    ×
                                </button>
                            </div>
                        ))}
                    </div>
                )}

                {/* VNCLUB Branded Header */}
                <div className="text-center mb-5">
                    <h1 className="text-4xl font-black tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-pink-400 to-purple-400 drop-shadow-lg" style={{ letterSpacing: '0.25em', textShadow: '0 0 30px rgba(236,72,153,0.4)' }}>
                        VNCLUB
                    </h1>
                    <div className="h-0.5 w-32 mx-auto mt-1 rounded-full bg-gradient-to-r from-yellow-400 via-pink-400 to-purple-400 opacity-70"></div>
                </div>

                {/* Navigation */}
                <div className="grid grid-cols-4 gap-3 mb-6">
                    <button onClick={() => navigate('/game')} className="bg-white bg-opacity-20 backdrop-blur-lg text-white py-3 rounded-lg font-semibold hover:bg-opacity-30 transition">Game</button>
                    <button onClick={() => navigate('/recharge')} className="bg-white bg-opacity-20 backdrop-blur-lg text-white py-3 rounded-lg font-semibold hover:bg-opacity-30 transition">Recharge</button>
                    <button onClick={() => navigate('/withdraw')} className="bg-white bg-opacity-20 backdrop-blur-lg text-white py-3 rounded-lg font-semibold hover:bg-opacity-30 transition">Withdraw</button>
                    <button onClick={() => navigate('/profile')} className="bg-white bg-opacity-20 backdrop-blur-lg text-white py-3 rounded-lg font-semibold hover:bg-opacity-30 transition">Profile</button>
                </div>

                {/* Header */}
                <div className="bg-white bg-opacity-10 backdrop-blur-lg rounded-2xl p-6 mb-6 shadow-xl">
                    <div className="flex justify-between items-center">
                        <div>
                            <h1 className="text-3xl font-bold text-white mb-2">Color Prediction Game</h1>
                            <p className="text-gray-300">Round #{roundId}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-gray-300 text-sm">Balance</p>
                            <p className="text-3xl font-bold text-yellow-400">₹{user.balance.toFixed(2)}</p>
                        </div>
                    </div>
                </div>

                {/* Timer */}
                <div className="bg-white bg-opacity-10 backdrop-blur-lg rounded-2xl p-8 mb-6 shadow-xl text-center">
                    <p className="text-gray-300 mb-2">Time Remaining</p>
                    <p className="text-6xl font-bold transition-colors duration-300" style={{ color: timerColor }}>
                        {timeLeft}s
                    </p>
                    {/* Progress bar */}
                    <div className="mt-4 h-2 bg-white bg-opacity-20 rounded-full overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all duration-1000"
                            style={{
                                width: `${(timeLeft / 60) * 100}%`,
                                backgroundColor: timerColor,
                            }}
                        />
                    </div>
                </div>

                {/* Betting Area */}
                <div className="bg-white bg-opacity-10 backdrop-blur-lg rounded-2xl p-6 mb-6 shadow-xl">
                    <h2 className="text-2xl font-bold text-white mb-4">Place Your Bet</h2>

                    {error && <div className="bg-red-500 bg-opacity-20 border border-red-500 text-red-200 px-4 py-3 rounded mb-4">{error}</div>}
                    {success && <div className="bg-green-500 bg-opacity-20 border border-green-500 text-green-200 px-4 py-3 rounded mb-4">{success}</div>}

                    <form onSubmit={handleBet} className="space-y-4">
                        {/* Color Bets */}
                        <div>
                            <p className="text-white mb-2 font-semibold">Select Color (2x)</p>
                            <div className="grid grid-cols-3 gap-3">
                                <button type="button" onClick={() => { setBetType('green'); setBetValue(null); }} className={`py-4 rounded-lg font-bold text-white transition ${betType === 'green' ? 'bg-green-600 ring-4 ring-green-400' : 'bg-green-500 hover:bg-green-600'}`}>
                                    GREEN
                                </button>
                                <button type="button" onClick={() => { setBetType('violet'); setBetValue(null); }} className={`py-4 rounded-lg font-bold text-white transition ${betType === 'violet' ? 'bg-purple-600 ring-4 ring-purple-400' : 'bg-purple-500 hover:bg-purple-600'}`}>
                                    VIOLET
                                </button>
                                <button type="button" onClick={() => { setBetType('red'); setBetValue(null); }} className={`py-4 rounded-lg font-bold text-white transition ${betType === 'red' ? 'bg-red-600 ring-4 ring-red-400' : 'bg-red-500 hover:bg-red-600'}`}>
                                    RED
                                </button>
                            </div>
                        </div>

                        {/* Size Bets */}
                        <div>
                            <p className="text-white mb-2 font-semibold">Select Size (2x)</p>
                            <div className="grid grid-cols-2 gap-3">
                                <button type="button" onClick={() => { setBetType('small'); setBetValue(null); }} className={`py-4 rounded-lg font-bold text-white transition ${betType === 'small' ? 'bg-blue-600 ring-4 ring-blue-400' : 'bg-blue-500 hover:bg-blue-600'}`}>
                                    SMALL
                                </button>
                                <button type="button" onClick={() => { setBetType('big'); setBetValue(null); }} className={`py-4 rounded-lg font-bold text-white transition ${betType === 'big' ? 'bg-orange-600 ring-4 ring-orange-400' : 'bg-orange-500 hover:bg-orange-600'}`}>
                                    BIG
                                </button>
                            </div>
                        </div>

                        {/* Number Bets */}
                        <div>
                            <p className="text-white mb-2 font-semibold">Select Number (8x)</p>
                            <div className="grid grid-cols-5 gap-2">
                                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => {
                                    let btnColor = 'bg-purple-500 hover:bg-purple-600';
                                    let ringColor = 'ring-purple-400';
                                    let activeColor = 'bg-purple-600';
                                    if ([1, 3, 7, 9].includes(num)) {
                                        btnColor = 'bg-green-500 hover:bg-green-600';
                                        ringColor = 'ring-green-400';
                                        activeColor = 'bg-green-600';
                                    } else if ([2, 4, 6, 8].includes(num)) {
                                        btnColor = 'bg-red-500 hover:bg-red-600';
                                        ringColor = 'ring-red-400';
                                        activeColor = 'bg-red-600';
                                    }
                                    const isActive = betType === 'number' && betValue === num;
                                    return (
                                        <button key={num} type="button" onClick={() => { setBetType('number'); setBetValue(num); }} className={`py-3 rounded-lg font-bold text-white transition ${isActive ? `${activeColor} ring-4 ${ringColor}` : btnColor}`}>
                                            {num}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Quick Amount Presets */}
                        <div>
                            <p className="text-white mb-2 font-semibold">Quick Amount</p>
                            <div className="grid grid-cols-4 gap-2 mb-2">
                                {[10, 50, 100, 500].map(preset => (
                                    <button key={preset} type="button" onClick={() => setAmount(String(preset))}
                                        className={`py-2 rounded-lg font-semibold text-sm transition ${amount === String(preset) ? 'bg-white text-purple-900' : 'bg-white bg-opacity-20 text-white hover:bg-opacity-30'}`}>
                                        ₹{preset}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Amount Input */}
                        <div>
                            <label className="block text-white mb-2 font-semibold">Bet Amount</label>
                            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Enter amount" required min="1" max={user.balance} className="w-full px-4 py-3 rounded-lg bg-white bg-opacity-20 text-white placeholder-gray-400 border border-white border-opacity-30 focus:outline-none focus:ring-2 focus:ring-white" />
                        </div>

                        {timeLeft <= 15 && (
                            <div className="bg-red-500 bg-opacity-20 border border-red-500 text-red-200 px-4 py-3 rounded animate-pulse">
                                ⏰ Betting closed — Less than 15 seconds remaining
                            </div>
                        )}

                        <button type="submit" disabled={loading || !betType || timeLeft <= 15} className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white py-4 rounded-lg font-bold text-lg hover:from-green-600 hover:to-blue-600 disabled:opacity-50 transition shadow-lg">
                            {loading ? 'Placing Bet...' : timeLeft <= 15 ? 'Betting Closed' : 'Place Bet'}
                        </button>
                    </form>
                </div>

                {/* Last Results */}
                <div className="bg-white bg-opacity-10 backdrop-blur-lg rounded-2xl p-6 shadow-xl">
                    <h2 className="text-2xl font-bold text-white mb-4">Last 20 Results</h2>
                    <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
                        {lastResults.map((r, i) => (
                            <div key={i} className="text-center">
                                <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-white mx-auto mb-1 shadow-lg" style={{ backgroundColor: r.color === 'green' ? '#10b981' : r.color === 'red' ? '#ef4444' : '#8b5cf6' }}>
                                    {r.result}
                                </div>
                                <p className="text-xs text-gray-400">#{r.roundId % 1000}</p>
                            </div>
                        ))}
                    </div>
                </div>

            </div>
        </div>
    );
}
