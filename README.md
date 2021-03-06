# SlateStarCommentServer
The thing that helps with the thing which highlights new comments on Slate Star Codex posts 

See https://github.com/bakkot/SlateStarComments

This is a server that queries WordPress's api, fetches the list of comments, and then exposes an endpoint indicating which comments are in reply to which other comments.

## Endpoints

You can check the status of the comment-fetching process here: https://sscnotify.bakkot.com/

And see a report on its uptime here: http://stats.pingdom.com/at8g7vi1e72k

To fetch replies for a user, query https://sscnotify.bakkot.com/replies.  This endpoint takes the following query string parameters:

`author_name` (required) the name of the author to fetch replies for

`from` (required) a unix timestamp in ms to fetch replies after

`page_size` (defaults to 10) the number of replies to return.  replies are returned in ascending chronological order, starting from "from".

`page` (defaults to 1) which page of replies to return, in "page_size" chunks.

This endpoint returns an array of comments in the same format as returned by the Wordpress API's comments endpoint (documented here: https://developer.wordpress.org/rest-api/reference/comments/).

For example, to return 10 replies to Scott's comments on Sept 1, 2014, you would visit: https://sscnotify.bakkot.com/replies?author_name=Scott%20Alexander&from=1409591958000

## Email Subscriptions

Users can sign up to get email notifications of replies to their comments at the following url: https://sscnotify.bakkot.com/subscribe.  This url takes one parameter, author_name.  For example: https://sscnotify.bakkot.com/subscribe?author_name=Scott%20Alexander.  

Once subscribed, users will get periodic emails with any new replies to that user name.  Emails have an unsubscribe link in them to cancel future subscriptions.