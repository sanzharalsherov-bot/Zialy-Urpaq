export type UserRole = 'ADMIN' | 'TEACHER' | 'STUDENT';
export type QuestionType =
  | 'SINGLE_CHOICE'
  | 'MULTIPLE_CHOICE'
  | 'SHORT_TEXT'
  | 'LONG_TEXT'
  | 'NUMERIC'
  | 'MATCHING'
  | 'FILL_BLANKS'
  | 'FILE_UPLOAD';
export type SubmissionStatus =
  | 'IN_PROGRESS'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'RETURNED'
  | 'GRADED'
  | 'EXPIRED';
