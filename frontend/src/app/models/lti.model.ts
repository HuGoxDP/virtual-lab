// path: src/app/models/lti.model.ts

/** `GET /api/lti/session`: what the platform knows about the LMS launch behind the `lti_session` cookie. */
export interface LtiSession {
  /** The scenario the launch points at; `null` for a deep-linking launch (the teacher is still choosing). */
  scenarioId: string | null;
  role: 'learner' | 'instructor';
  messageType: 'resource' | 'deep-link';
  /** Whether the scenario reports a score (`graded` in its manifest); non-graded ones submit the maximum. */
  graded: boolean;
  /** The grade Moodle already holds for this launch, if any. */
  submitted: { score: number } | null;
}
