# A quick guide to School Learning Simplified

## What it is

School Learning Simplified connects a teacher’s classroom note with the next step
at home. Children learn, parents help, and teachers see recorded work. Children
can also use the library independently.

The current library has **Our Earth** and **Animal Life**, Class 4 CBSE
Environmental Studies, in English and Hindi. It works in a phone or laptop browser.

## Try it in two minutes

**For judges:** use the teacher, student and parent sign-in details provided with
the submission. These prepared accounts need no verification email. The teacher
and parent start at [School](https://schoollearningsimplified.com/school); the
student starts at [My library](https://schoollearningsimplified.com/).
Their fictional school is **Neem Tree Public School · Class 4A**.

Start as the student with **Our Earth → Learn**, then try the teacher’s results
and the parent’s updates. Separate browser profiles let you keep roles open
together. **Sign out** ends only the current session. Demo accounts are shared;
keep names and messages fictional.

**Trying it yourself:** choose **Sign up**, enter your own email and password,
and confirm the emailed code. No school connection is needed to use the library.

## As a student

1. Sign in and choose your name, **Class 4**, **CBSE** and language once. The judge
   student’s setup is already done.
2. Choose Environmental Studies, then a chapter. **Learn** explains each idea with
   narration and drawings. If audio does not start, tap **Play** once.
3. Use **Revise** to recall an answer, reveal it, then mark the card reviewed.
   **Practice** gives you ten questions: review your answers and submit the set to
   see your score and explanations.
4. Open **My report card** on the library home. Open your name at the top to change
   **Preferred learning language**, or switch languages while studying.

## As a teacher

Use the prepared demo school, or open **School → Register a school** with your
own verified account. The school administrator adds teachers, creates a class
with **Add class**, assigns its teacher and records the students’ and parents’
separate emails.

Open your class and **Classroom notes**. Try “Homework: practise Our Earth.”
Choose **Save classroom note**. Llama finds the chapter, activity and
intended children; the app checks and publishes valid guidance automatically,
without a teacher approval step. Unclear details are shown for correction.

Use **Learning guidance & results** to follow recorded activity and scores.
Scores describe saved work, not mastery.

In **Family updates**, choose **One child and their linked parents**. Write your
own feedback, or open **Draft with Llama**, choose a lesson idea and language, and
describe what you noticed. Read and edit the draft, then choose **Publish update**.
Drafting alone sends nothing. Parent replies appear under **Private replies**.
Daily AI limits do not stop you reading guidance or writing updates yourself.

## As a parent

Sign in with the separate, verified parent email recorded by the school. This
links your child automatically; ask the school to correct a missing link. No
learner setup is needed.

Open **School → Parent**. Your child’s card shows next steps and **View report
card**. Choose **Open classroom updates**, read an update, **Acknowledge** it and
reply privately to its teacher. New markers show unread activity. Your child
learns from their own student account; viewing their work does not change it.
The judge parent is already linked and named. Shared-demo replies stay in the app;
no email inbox is needed.

## Where Meta’s Llama helps

The live website uses **Llama 3.3 70B on Amazon Bedrock** to interpret classroom
notes and draft parent notes from the selected lesson material. It never grades
children or invents new lessons while they use the app. Practice is checked against
prepared answer keys; the learning library is prepared content.

A separate [Content Lab](content-lab-llama/README.md) uses **LangGraph and Llama 4
Maverick** for authoring workflows. As of **30 October 2026**, its furthest live run
completed **8 of 18 stages**, including Hindi translation, a static visual and
an English narrated board video. The complete pipeline has not yet finished a live run.
It did not produce this app’s existing lesson library.

## Languages and privacy

Learning content and learner controls support English and Hindi. Teacher and
parent workspace controls are currently in English; parent notes can be drafted
in either language.

Recognized children’s names are replaced with aliases before Llama receives a
teacher note. Original classroom notes stay with school staff. Family replies and
acknowledgements are private to the linked parent and the update’s teacher;
children can see their original family update, not that private conversation.

## Built during the hackathon

The lesson content and the agents' starting prompts were prepared by the founder before the event; all the code was written during it.

## Useful links

- [Live website](https://schoollearningsimplified.com/)
- [School and family workspace](https://schoollearningsimplified.com/school)
- [Watch the demo film](https://schoollearningsimplified.com/media/film/53a9b75e369d2916/index.html)
- [Source repository](https://github.com/manishjain-py/school-learning-simplified)
