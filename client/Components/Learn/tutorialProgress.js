import { TutorialSteps } from './tutorialScript';

/**
 * ARCHON (N11): where the reader got to in the tutorial.
 *
 * Deliberately localStorage rather than the account: the whole point of the
 * Learn tab is that someone can try KeyForge before they sign up, and asking
 * them to register to keep their place would defeat it. A blocked or full
 * localStorage costs nothing but the resume point.
 */

const PROGRESS_KEY = 'archon.learn.tutorial.step';

export const totalSteps = () => TutorialSteps.length;

export const readSavedStep = () => {
    try {
        const saved = Number(window.localStorage.getItem(PROGRESS_KEY));

        return Number.isInteger(saved) && saved > 0 && saved < TutorialSteps.length ? saved : 0;
    } catch {
        return 0;
    }
};

export const writeSavedStep = (step) => {
    try {
        window.localStorage.setItem(PROGRESS_KEY, String(step));
    } catch {
        // Nothing to do: the tutorial still works, it just will not resume.
    }
};

export const clearSavedStep = () => writeSavedStep(0);
