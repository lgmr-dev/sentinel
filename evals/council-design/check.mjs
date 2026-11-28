import { git, seatReplies, hostFamily, check, report } from '../lib.mjs';

const seats = seatReplies('council');
const chair = hostFamily();
check('asks each seat', !seats.error && seats.members.every(m => m.replies >= 1), seats.detail);
check('asks a judge from another family', seats.members.some(m => m.family && m.family !== chair && m.replies >= 2), seats.detail);
check('changes no file', git('status', '--porcelain').stdout.trim() === '');
report();
