--This is the schema for our comment database.
--It's compatible with postgres 9.6 or higher


--public.comments
--Record of all the comments we fetch.  We store the raw json, and we pull out
--the id field, and a timestamp field (which we convert from the string format into
--a number) for easier querying.
--
--We also have an application generated field, in_reply_to, where we store the author
--names of users we consider this comment to be replying to (we support more than one
--in order to enable @-replies)
--
CREATE TABLE public.comments (
    id bigint PRIMARY KEY,      --The id assigned to the comment in postgres
    data jsonb,                 --The full output from the wordpress API
    timestamp bigint,           --timestamp in ms when this comment was posted
    in_reply_to text[]          --author_names that we consider this comment a reply to
);


--To support chronological traversal / seeing when the latest comment was
CREATE INDEX comments_by_timestamp on public.comments (timestamp);

--Support chronological traversal of a specific author's comments
CREATE INDEX comments_by_author on public.comments ((data->'author_name'), timestamp);


--Stores tokens that prove ownership of an email address
CREATE TABLE public.tokens (
    id text PRIMARY KEY,        --The token
    email text,                 --The email it was generated for
    expiration bigint           --The date the token is valid for
);

--Stores subscriptions for a given email to a given author_name's replies
CREATE TABLE public.subscriptions (
    id text PRIMARY KEY,        --The id of the subscription (used as the unsubscribe token)
    email text,                 --The email to send replies to
    author_name text            --The author_name to send replies for.
);

--Enforce only one subscription per email / author_name pairing
CREATE UNIQUE INDEX email_author_name on public.subscriptions (email, author_name);

--Look up subscriptions by author_name
CREATE INDEX subscriptions_by_author ON public.subscriptions (author_name);

--A one-row table indicated the timestamp through which we've sent email notifications
CREATE TABLE public.current_email_status (
    id int PRIMARY KEY,
    timestamp bigint
)