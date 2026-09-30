// Stand-ins for desktop-only helpers the shared agent code calls.
// - stealth: the extension runs in the user's own real Chrome, so there's nothing to disguise.
// - captcha_solver: the extension never solves CAPTCHAs; if one appears, the user completes it.
module.exports = {
  applyToContext: async () => {},
  applyToPage: async () => {},
  autoSolve: async () => false,
  detect: async () => null,
  solve: async () => false,
};
