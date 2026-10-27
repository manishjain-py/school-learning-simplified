export type School = { id: string; name: string; timeZone: string; createdAt: string };
export type SchoolRole = 'admin' | 'teacher';
export type SchoolClass = { id: string; name: string; subject: string; teacherEmails: string[]; version: number };
export type Teacher = { email: string; name: string; version: number };
export type RosterStudent = { id: string; name: string; studentEmail: string; parentEmails: string[]; version: number };
export type LinkedChild = { id: string; schoolId: string; schoolName: string; classId: string; className: string; name: string };
export type Workspaces = {
  staff: { school: School; role: SchoolRole }[];
  family: {
    student: { status: 'linked' | 'missing' | 'ambiguous'; children: LinkedChild[]; matchCount: number };
    parent: { status: 'linked' | 'missing'; children: LinkedChild[] };
  };
};
export type SchoolDetail = { school: School; role: SchoolRole; classes: SchoolClass[]; teachers: Teacher[] };
export type MutationResult = { warning?: string };
