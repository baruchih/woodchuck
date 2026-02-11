import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { Button } from "../components/Button";
import {
  PIRATE_INSULTS,
  SWORD_MASTER_COMEBACKS,
  PIRATE_NAMES,
  SWORD_MASTER_NAME,
  STORAGE_KEYS,
  POINTS_TO_WIN,
  INSULTS_TO_UNLOCK_SWORD_MASTER,
  type InsultPair,
} from "../data/insults";

// Game phases
type GamePhase =
  | "menu"
  | "fighting"
  | "player_turn"
  | "round_result"
  | "duel_end";

interface GameState {
  phase: GamePhase;
  opponent: string;
  isSwordMaster: boolean;
  playerScore: number;
  opponentScore: number;
  currentInsult: string | null;
  selectedComeback: string | null;
  isCorrect: boolean | null;
  roundMessage: string | null;
  learnedPair: InsultPair | null;
}

// Helper to shuffle an array
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Pick random item
function randomItem<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)];
}

// Generate a random insult
function getRandomInsult(): string {
  const insultIndex = Math.floor(Math.random() * PIRATE_INSULTS.length);
  return PIRATE_INSULTS[insultIndex].insult;
}

// Load learned insults from localStorage
function loadLearnedInsults(): Set<number> {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.learnedInsults);
    if (stored) {
      return new Set(JSON.parse(stored) as number[]);
    }
  } catch {
    // Ignore errors
  }
  return new Set();
}

// Save learned insults to localStorage
function saveLearnedInsults(learned: Set<number>) {
  localStorage.setItem(
    STORAGE_KEYS.learnedInsults,
    JSON.stringify([...learned])
  );
}

// Load pirate wins count
function loadPirateWins(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.pirateWins);
    if (stored) {
      return parseInt(stored, 10) || 0;
    }
  } catch {
    // Ignore errors
  }
  return 0;
}

// Save pirate wins count
function savePirateWins(wins: number) {
  localStorage.setItem(STORAGE_KEYS.pirateWins, String(wins));
}

// Check if sword master is defeated
function isSwordMasterDefeated(): boolean {
  return localStorage.getItem(STORAGE_KEYS.swordMasterDefeated) === "true";
}

// Mark sword master as defeated
function markSwordMasterDefeated() {
  localStorage.setItem(STORAGE_KEYS.swordMasterDefeated, "true");
}

const INITIAL_STATE: GameState = {
  phase: "menu",
  opponent: "",
  isSwordMaster: false,
  playerScore: 0,
  opponentScore: 0,
  currentInsult: null,
  selectedComeback: null,
  isCorrect: null,
  roundMessage: null,
  learnedPair: null,
};

export function InsultSwordFightPage() {
  const navigate = useNavigate();

  // Persistent state
  const [learnedInsults, setLearnedInsults] = useState<Set<number>>(() =>
    loadLearnedInsults()
  );
  const [pirateWins, setPirateWins] = useState(() => loadPirateWins());
  const [swordMasterBeaten, setSwordMasterBeaten] = useState(() =>
    isSwordMasterDefeated()
  );

  // Game state
  const [game, setGame] = useState<GameState>(INITIAL_STATE);

  // Timer ref for cleanup
  const timerRef = useRef<number | null>(null);

  // Compute comeback options for current insult
  const comebackOptions = useMemo(() => {
    if (!game.currentInsult) return [];

    // Get the correct comeback
    const correctComeback = game.isSwordMaster
      ? SWORD_MASTER_COMEBACKS[game.currentInsult]
      : PIRATE_INSULTS.find((p) => p.insult === game.currentInsult)?.comeback;

    if (!correctComeback) return [];

    // Get 2 random wrong comebacks
    const allComebacks = PIRATE_INSULTS.map((p) => p.comeback);
    const wrongComebacks = allComebacks
      .filter((c) => c !== correctComeback)
      .slice(0, 10);
    const selectedWrong = shuffle(wrongComebacks).slice(0, 2);

    // Combine and shuffle
    return shuffle([correctComeback, ...selectedWrong]);
  }, [game.currentInsult, game.isSwordMaster]);

  // Save state changes to localStorage
  useEffect(() => {
    saveLearnedInsults(learnedInsults);
  }, [learnedInsults]);

  useEffect(() => {
    savePirateWins(pirateWins);
  }, [pirateWins]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  // Handle phase transitions with useEffect
  useEffect(() => {
    if (game.phase === "fighting") {
      // Transition from fighting to player_turn after a short delay
      timerRef.current = window.setTimeout(() => {
        setGame((prev) => ({
          ...prev,
          phase: "player_turn",
          currentInsult: getRandomInsult(),
        }));
      }, 500);
    }
  }, [game.phase]);

  // Can challenge sword master?
  const canChallengeSwordMaster =
    learnedInsults.size >= INSULTS_TO_UNLOCK_SWORD_MASTER;

  // Start a new duel
  const startDuel = useCallback((challengeSwordMaster: boolean) => {
    const opponent = challengeSwordMaster
      ? SWORD_MASTER_NAME
      : randomItem(PIRATE_NAMES);

    setGame({
      phase: "fighting",
      opponent,
      isSwordMaster: challengeSwordMaster,
      playerScore: 0,
      opponentScore: 0,
      currentInsult: null,
      selectedComeback: null,
      isCorrect: null,
      roundMessage: null,
      learnedPair: null,
    });
  }, []);

  // Player selects a comeback
  const selectComeback = useCallback(
    (comeback: string) => {
      if (game.phase !== "player_turn" || !game.currentInsult) return;

      // Check if correct
      const correctComeback = game.isSwordMaster
        ? SWORD_MASTER_COMEBACKS[game.currentInsult]
        : PIRATE_INSULTS.find((p) => p.insult === game.currentInsult)?.comeback;

      const isCorrect = comeback === correctComeback;

      // Find the insult index to potentially learn it
      const insultIndex = PIRATE_INSULTS.findIndex(
        (p) => p.insult === game.currentInsult
      );

      // If player loses this round and hasn't learned this insult, learn it
      let learnedPair: InsultPair | null = null;
      if (!isCorrect && insultIndex >= 0 && !learnedInsults.has(insultIndex)) {
        learnedPair = PIRATE_INSULTS[insultIndex];
        setLearnedInsults((prev) => {
          const next = new Set(prev);
          next.add(insultIndex);
          return next;
        });
      }

      const newPlayerScore = game.playerScore + (isCorrect ? 1 : 0);
      const newOpponentScore = game.opponentScore + (isCorrect ? 0 : 1);

      const roundMessage = isCorrect
        ? randomItem([
            "Ha! A worthy riposte!",
            "Touche! You got me there.",
            "Blast! A clever comeback!",
            "Argh! Well said, scurvy dog!",
          ])
        : randomItem([
            "Ha ha ha! Pathetic!",
            "Is that the best you've got?",
            "My grandmother fights better!",
            "You call that a comeback?",
          ]);

      // Update to round_result phase
      setGame((prev) => ({
        ...prev,
        phase: "round_result",
        selectedComeback: comeback,
        isCorrect,
        playerScore: newPlayerScore,
        opponentScore: newOpponentScore,
        roundMessage,
        learnedPair,
      }));

      // Check for duel end or next round after a delay
      timerRef.current = window.setTimeout(() => {
        if (newPlayerScore >= POINTS_TO_WIN) {
          // Player wins
          setGame((prev) => ({
            ...prev,
            phase: "duel_end",
          }));

          // Update win count or sword master status
          if (game.isSwordMaster) {
            setSwordMasterBeaten(true);
            markSwordMasterDefeated();
          } else {
            setPirateWins((prev) => prev + 1);
          }
        } else if (newOpponentScore >= POINTS_TO_WIN) {
          // Opponent wins
          setGame((prev) => ({
            ...prev,
            phase: "duel_end",
          }));
        } else {
          // Continue fighting - go to next round
          setGame((prev) => ({
            ...prev,
            phase: "player_turn",
            currentInsult: getRandomInsult(),
            selectedComeback: null,
            isCorrect: null,
            roundMessage: null,
            learnedPair: null,
          }));
        }
      }, 2000);
    },
    [game, learnedInsults]
  );

  // Return to menu
  const returnToMenu = useCallback(() => {
    setGame(INITIAL_STATE);
  }, []);

  // Reset progress
  const resetProgress = useCallback(() => {
    setLearnedInsults(new Set());
    setPirateWins(0);
    setSwordMasterBeaten(false);
    localStorage.removeItem(STORAGE_KEYS.learnedInsults);
    localStorage.removeItem(STORAGE_KEYS.pirateWins);
    localStorage.removeItem(STORAGE_KEYS.swordMasterDefeated);
  }, []);

  // Render score dots
  const renderScore = (score: number, max: number) => {
    return Array(max)
      .fill(0)
      .map((_, i) => (
        <span
          key={i}
          className={`inline-block w-3 h-3 rounded-full mx-0.5 ${
            i < score ? "bg-primary" : "bg-border"
          }`}
        />
      ));
  };

  // Did player win?
  const playerWon = game.playerScore >= POINTS_TO_WIN;

  return (
    <Layout title="Insult Sword Fighting" showBack onBack={() => navigate("/")}>
      <div className="flex-1 overflow-y-auto p-4">
        {/* Menu Phase */}
        {game.phase === "menu" && (
          <div className="max-w-lg mx-auto space-y-6">
            {/* Header */}
            <div className="text-center py-4">
              <div className="text-4xl mb-2">{"///"}</div>
              <h2 className="text-lg text-primary uppercase tracking-wider">
                Insult Sword Fighting
              </h2>
              <p className="text-text-muted text-xs mt-2">
                Master the art of witty comebacks
              </p>
            </div>

            {/* Progress */}
            <div className="bg-surface border border-border rounded-sm p-4">
              <h3 className="text-xs uppercase tracking-wider text-text-muted mb-3">
                Your Progress
              </h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span>Insults learned:</span>
                  <span className="text-primary">
                    {learnedInsults.size}/{PIRATE_INSULTS.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Pirates defeated:</span>
                  <span className="text-primary">{pirateWins}</span>
                </div>
                <div className="flex justify-between">
                  <span>Sword Master:</span>
                  <span
                    className={
                      swordMasterBeaten ? "text-status-success" : "text-text-muted"
                    }
                  >
                    {swordMasterBeaten ? "DEFEATED" : "Undefeated"}
                  </span>
                </div>
              </div>
            </div>

            {/* How to play */}
            <div className="bg-surface border border-border rounded-sm p-4">
              <h3 className="text-xs uppercase tracking-wider text-text-muted mb-3">
                How to Play
              </h3>
              <ul className="text-xs text-text space-y-2 list-disc list-inside">
                <li>Pirates insult you - pick the right comeback!</li>
                <li>First to {POINTS_TO_WIN} correct responses wins</li>
                <li>When you LOSE, you learn the insult/comeback pair</li>
                <li>
                  Learn {INSULTS_TO_UNLOCK_SWORD_MASTER}+ insults to challenge
                  the Sword Master
                </li>
                <li>The Sword Master's comebacks are... different</li>
              </ul>
            </div>

            {/* Actions */}
            <div className="space-y-3">
              <Button fullWidth onClick={() => startDuel(false)}>
                Fight a Pirate
              </Button>

              {canChallengeSwordMaster && (
                <Button
                  fullWidth
                  variant={swordMasterBeaten ? "ghost" : "primary"}
                  onClick={() => startDuel(true)}
                >
                  {swordMasterBeaten
                    ? "Rematch Sword Master"
                    : "Challenge the Sword Master!"}
                </Button>
              )}

              {!canChallengeSwordMaster && (
                <p className="text-center text-xs text-text-muted">
                  Learn {INSULTS_TO_UNLOCK_SWORD_MASTER - learnedInsults.size}{" "}
                  more insults to unlock the Sword Master
                </p>
              )}

              <button
                onClick={resetProgress}
                className="w-full text-xs text-text-muted hover:text-status-error py-2"
              >
                Reset Progress
              </button>
            </div>
          </div>
        )}

        {/* Fighting Phases */}
        {game.phase !== "menu" && game.phase !== "duel_end" && (
          <div className="max-w-lg mx-auto space-y-6">
            {/* Opponent */}
            <div className="text-center py-4">
              <div className="text-2xl mb-2">
                {game.isSwordMaster ? "///" : "o7"}
              </div>
              <h2 className="text-lg text-primary uppercase tracking-wider">
                {game.opponent}
              </h2>
            </div>

            {/* Scores */}
            <div className="flex justify-center gap-8 text-sm">
              <div className="text-center">
                <div className="text-text-muted text-xs mb-1">You</div>
                <div>{renderScore(game.playerScore, POINTS_TO_WIN)}</div>
              </div>
              <div className="text-center">
                <div className="text-text-muted text-xs mb-1">Them</div>
                <div>{renderScore(game.opponentScore, POINTS_TO_WIN)}</div>
              </div>
            </div>

            {/* Current insult */}
            {game.currentInsult && (
              <div className="bg-surface border border-border rounded-sm p-4">
                <div className="text-xs text-text-muted uppercase tracking-wider mb-2">
                  {game.opponent} says:
                </div>
                <p className="text-text italic">"{game.currentInsult}"</p>
              </div>
            )}

            {/* Comeback options */}
            {game.phase === "player_turn" && (
              <div className="space-y-2">
                <div className="text-xs text-text-muted uppercase tracking-wider mb-2">
                  Your comeback:
                </div>
                {comebackOptions.map((comeback, index) => (
                  <button
                    key={index}
                    onClick={() => selectComeback(comeback)}
                    className="w-full text-left bg-surface hover:bg-surface-alt border border-border hover:border-primary rounded-sm p-3 text-sm transition-colors btn-active"
                  >
                    "{comeback}"
                  </button>
                ))}
              </div>
            )}

            {/* Round result */}
            {game.phase === "round_result" && (
              <div className="space-y-4">
                {/* What you said */}
                <div className="bg-surface border border-border rounded-sm p-4">
                  <div className="text-xs text-text-muted uppercase tracking-wider mb-2">
                    You said:
                  </div>
                  <p
                    className={`italic ${
                      game.isCorrect ? "text-status-success" : "text-status-error"
                    }`}
                  >
                    "{game.selectedComeback}"
                  </p>
                </div>

                {/* Opponent reaction */}
                <div
                  className={`text-center py-2 ${
                    game.isCorrect ? "text-status-success" : "text-status-error"
                  }`}
                >
                  <div className="text-lg font-bold">
                    {game.isCorrect ? "HIT!" : "MISS!"}
                  </div>
                  <div className="text-xs mt-1">{game.roundMessage}</div>
                </div>

                {/* Learned new insult */}
                {game.learnedPair && (
                  <div className="bg-surface-alt border border-status-needs-input rounded-sm p-4">
                    <div className="text-xs text-status-needs-input uppercase tracking-wider mb-2">
                      NEW INSULT LEARNED!
                    </div>
                    <p className="text-xs text-text-muted mb-1">
                      "{game.learnedPair.insult}"
                    </p>
                    <p className="text-xs text-primary">
                      -{">"} "{game.learnedPair.comeback}"
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Loading next round */}
            {game.phase === "fighting" && (
              <div className="text-center py-8">
                <div className="spinner mx-auto mb-4" />
                <p className="text-text-muted text-xs">En garde!</p>
              </div>
            )}
          </div>
        )}

        {/* Duel End */}
        {game.phase === "duel_end" && (
          <div className="max-w-lg mx-auto space-y-6">
            <div className="text-center py-8">
              <div className="text-4xl mb-4">
                {playerWon ? "\\o/" : ">_<"}
              </div>
              <h2
                className={`text-xl uppercase tracking-wider ${
                  playerWon ? "text-status-success" : "text-status-error"
                }`}
              >
                {playerWon ? "VICTORY!" : "DEFEAT!"}
              </h2>
              <p className="text-text-muted text-sm mt-2">
                {playerWon
                  ? game.isSwordMaster
                    ? "You have defeated the Sword Master! You are truly a mighty pirate!"
                    : "Another pirate bites the dust!"
                  : "Better luck next time, you landlubber!"}
              </p>

              {/* Final score */}
              <div className="flex justify-center gap-8 text-sm mt-6">
                <div className="text-center">
                  <div className="text-text-muted text-xs mb-1">You</div>
                  <div className="text-lg text-primary">{game.playerScore}</div>
                </div>
                <div className="text-center">
                  <div className="text-text-muted text-xs mb-1">
                    {game.opponent}
                  </div>
                  <div className="text-lg text-status-error">
                    {game.opponentScore}
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <Button fullWidth onClick={() => startDuel(game.isSwordMaster)}>
                {playerWon ? "Fight Again" : "Rematch!"}
              </Button>
              <Button fullWidth variant="ghost" onClick={returnToMenu}>
                Back to Menu
              </Button>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
