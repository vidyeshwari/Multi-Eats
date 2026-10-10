// Input rules shared by the gateway (and unit-tested). Plain functions, no dependencies.
// Phone: exactly 10 digits, first digit 7, 8 or 9.
const PHONE_RE = /^[789][0-9]{9}$/;
const phoneProblem = phone => PHONE_RE.test(String(phone ?? '').trim())
  ? null : 'Phone number must be exactly 10 digits and start with 7, 8 or 9';

const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'letmein', 'welcome', 'admin', 'iloveyou', 'abc123', 'monkey',
  'dragon', 'football', 'login', 'princess', 'sunshine', 'master', 'shadow', 'multieats', 'restaurant', 'owner', 'test'];
const SEQ = 'abcdefghijklmnopqrstuvwxyz0123456789qwertyuiopasdfghjklzxcvbnm';

// Returns a list of the rules the password breaks ([] = strong enough).
function passwordProblems(pw, { email = '', name = '' } = {}) {
  const p = String(pw ?? ''), low = p.toLowerCase(), out = [];
  if (p.length < 8) out.push('at least 8 characters');
  if (p.length > 64) out.push('at most 64 characters');
  if (!/[A-Z]/.test(p)) out.push('an uppercase letter');
  if (!/[a-z]/.test(p)) out.push('a lowercase letter');
  if (!/[0-9]/.test(p)) out.push('a number');
  if (!/[^A-Za-z0-9\s]/.test(p)) out.push('a special character (e.g. @ # $ !)');
  if (/\s/.test(p)) out.push('no spaces');
  if (/(.)\1{3,}/.test(p)) out.push('no character repeated 4 or more times');
  for (let i = 0; i + 4 <= low.length; i++) {
    const s = low.slice(i, i + 4), r = [...s].reverse().join('');
    if (SEQ.includes(s) || SEQ.includes(r)) { out.push('no easy sequences like 1234 or abcd'); break; }
  }
  const local = String(email).split('@')[0].toLowerCase();
  if (COMMON.some(w => low.includes(w) && low.length <= w.length + 4)) out.push('not a common password');
  if (local.length >= 4 && low.includes(local)) out.push('must not contain your email name');
  const part = String(name).toLowerCase().split(/\s+/).find(x => x.length >= 4 && low.includes(x));
  if (part) out.push('must not contain your name');
  return out;
}
const passwordProblem = (pw, ctx) => {
  const p = passwordProblems(pw, ctx);
  return p.length ? 'Password is too weak. It needs: ' + p.join(', ') : null;
};
module.exports = { phoneProblem, passwordProblem, passwordProblems, PHONE_RE };
