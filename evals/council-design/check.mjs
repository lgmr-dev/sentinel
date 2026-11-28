import { git, seatReplies, hostFamily, check, report } from '../lib.mjs';

const seats = seatReplies('council');
const chair = hostFamily();
check('asks each seat', !seats.error && seats.members.every(m => m.replies >= 1), seats.detail);
const judges = seats.members.filter(m => m.family && m.family !== chair);
check('asks a judge from another family', !judges.length || judges.some(m => m.replies >= 2), seats.detail);
check('changes no file', git('status', '--porcelain').stdout.trim() === '');
report();
