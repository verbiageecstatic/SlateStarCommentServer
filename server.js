//This is the main entrypoint for starting up our server.
//If loaded as the main module, will start the server and start fetching
//comments from wordpress.  See bottom of file for the startup code

//Tested on node v6.10.2

//Run this in an anonymous function to avoid accidentally creating global variables
(function() {

//Dependencies
var pg = require('pg');
var fs = require('fs');
var fibers = require('fibers');
var block = require('./block');
var Block = block.Block;
var request = require('request');
var querystring = require('querystring');
var express = require('express');
var url = require('url')
var greenlock_express = require('greenlock-express');
var bodyParser = require('body-parser')
var crypto = require('crypto')

//How soon we kick off the loading-new-comments process after the last one finishes
var LOAD_COMMENTS_EVERY = 10*1000;
//How long we wait before retrying the loading-new-comments process if it fails
var FAIL_RETRY = 5*60*1000;
//The number of pages of results we load before committing the transaction
var MAX_PAGES = 10;


//cache our loaded configuration
var _config_cache; 

//Track how caught up we are
var latestTimestamp = null;
//If we hit an error fetching comments, save it
var lastError = null;


//Loads our configuration from config.json.  This is a git-ignored file
//that we use to store credentials + settings that we don't want to check
//into git
function get_config() {
    //If we haven't yet, load it from disk
    if (!_config_cache) {
        try {
            _config_cache = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        } catch (err) {
            //If we can't load config, we have to shutdown
            console.log('Unable to load and parse config.json.  Error was:');
            console.log(err.stack);
            process.exit(1);
        }
    }
    return _config_cache;
}


//store our pool of postgres clients
var _pool_cache; 

//Returns our pool of postgres clients
function get_pool() {
    //If we haven't created a pool yet, create it now
    if (!_pool_cache) {
        var postgres = get_config().postgres;
        if (!postgres) {
            //If we don't have settings for postgres, this is a fatal error
            var msg = 'No "postgres" object found in config.json.  Expecting an object';
            msg += ' with some or all of these fields: "user", "database", "password",';
            msg += ' "host", "port", "max", "idleTimeoutMillis".  See new pg.Pool at ';
            msg += 'https://github.com/brianc/node-postgres';
            console.log(msg);
            
            process.exit(1);
        }
        _pool_cache = new pg.Pool(postgres);
    }
    return _pool_cache;
}

//Runs a function passing in a postgres client with a sync query function, which we release on completion
function withClient(fn) {
    var client = block.await(get_pool().connect())
    try {
        var c = {
            query: function (sql, params) {
                return block.await(client.query(sql, params));
            }
        }
        return fn(c);
    } finally {
        client.release();
    }
}

//Runs a function passing in a postgres client.  Starts a transaction, and automatically
//rolls back on error or commits on success
function transaction(fn) {
    withClient(function(client) {
        try {
            client.query('BEGIN');
            ret = fn(client);
            client.query('COMMIT');
            return ret;
        } catch (err) {
            client.query('ROLLBACK');
            throw err;
        }
    });
}


//Fetches all the comments that have come in since we last fetched,
//and persists them to the database as a single transaction.
function fetchComments() {
    //Track the latest timestamp for this operation.  On commit, we update the global
    //latestTimestamp variable
    var lt = null;

    //We run this entire operation as a transaction to protect against accidentally
    //having two comment-fetching processes running at once
    transaction(function(client) {
        //Acquire a lock so that only one process does this at a time
        client.query('SELECT pg_advisory_xact_lock(352342)');
        
        //Find our most recent comment, so we can get comments after that one
        var res = client.query('SELECT timestamp FROM public.comments ORDER BY timestamp DESC LIMIT 1');
        var start;
        if (res.rows[0]) {
             start = parseInt(res.rows[0].timestamp);
        } else {
            //Start from the beginning of time (plus a bit because Wordpress errors if start = 0)
            start = 86400000; 
        }
        
        //We maintain a cache of comment ids to author names, because comments will
        //generally be in reply to recently posted comments, so it makes sense to remember
        //so we don't have to constantly query the database
        var ids_to_author_name = {}
        
        //Given a comment id, looks up the author name
        function getAuthorName(id) {
            //If we have it already, just return it
            if (ids_to_author_name[id]) {
                return ids_to_author_name[id];
            }
            
            //Otherwise, look it up from the database
            res = client.query("SELECT data->'author_name'::text as author_name FROM public.comments WHERE id = $1", [id])
            if (!res.rows[0] || !res.rows[0].author_name) { return null; }
            ids_to_author_name[id] = res.rows[0].author_name;
            return ids_to_author_name[id];
        }
        
        //Start from the first page of results, and go until there are no more results
        //or we are at MAX_PAGES
        var page = 1;
        while (page <= MAX_PAGES) {
        
            //Build the parameters to make the call to the wordpress API
            var url = get_config().api_base + '/wp-json/wp/v2/comments?'
            var params = {
                page: page,
                per_page: 100,
                after: (new Date(start)).toISOString(),
                order: 'asc'
            }
            url = url + querystring.stringify(params);
            
            //Temporary debugging:
            //console.log('Fetching ' + url);
            
            //Do the request and error if it's not a 200 response
            var block = Block();
            request(url, block.make_cb());
            response = block.wait();
            if (response.statusCode !== 200) {
                throw new Error('Non-200 response from ' + url + ': ' + response.statusCode + ' ' + response.body)
            }
            
            var comments = JSON.parse(response.body);
            
            //If there are no comments, we're at the end of the pagination, so break out of the while loop
            if (comments.length === 0) { break; }
            
            //Go through each comment, calculate the timestamp and in_reply_to fields,
            //and persist to the database
            var comment, timestamp, in_reply_to, params;
            for (var i = 0; i < comments.length; i++) {
                comment = comments[i];
                
                //update our ids_to_author_name hash
                ids_to_author_name[comment.id] = comment.author_name;
                
                timestamp = (new Date(comment.date_gmt)).valueOf();
                if (timestamp < lt) {
                    throw new Error('assertion error: got out-of-order timestamps');
                }
                lt = timestamp
                
                in_reply_to = []
                
                //See if there any explicit @ references
                //Currently, we count anything from an @ to a non-alphanumeric, non-space 
                //character as the author name.  (This is because usually they'll be a 
                //comma or a <p> at the end of the name).
                //We trim whitespace
                var regex = /@([a-zA-Z0-9\. ]+)/g
                while (match = regex.exec(comment.content.rendered)) {
                    in_reply_to.push(match[1].trim());
                    
                    //TODO: can we compare unrecognized author names against our comment
                    //database and see if we can guess who they were referring to?
                }
                
                //See if there is a parent post
                if (comment.parent && getAuthorName(comment.parent)) {
                    in_reply_to.push(getAuthorName(comment.parent));
                }
                
                //Write the comment to postgres
                params = [comment.id, comment, timestamp, in_reply_to]
                client.query("INSERT INTO public.comments (id, data, timestamp, in_reply_to) VALUES ($1,$2,$3,$4)", params)
                
                //Temporary debugging
                //console.log('Added: ' + JSON.stringify(params, null, 4));
            }
            
            page++;
        }
    });
    
    //We've successfully committed, so update the latest timestamp,
    //and clear last error
    if (lt === null) {
        latestTimestamp = 'up-to-date';
    } else {
        latestTimestamp = lt;
    }
    lastError = null;
    
    //Temporary debugging
    //console.log('Successfully committed');
}

//Express route that displays the status of the comment downloading
function statusEndpoint (req, res, next) {
    try {
        var msg = 'Status: ';
        if (lastError) {
            msg += 'unhealthy\n\nLast error:\n' + lastError.stack
        } else if (latestTimestamp) {
            msg += 'healthy'
        } else {
            msg += 'starting up'
        }
        if (latestTimestamp === 'up-to-date') {
            msg += '\n\n\nCaught up to the present time'
        } else if (latestTimestamp) {
            msg += '\n\n\nCaught up to: ' + String(new Date(latestTimestamp))
        }
        res.end(msg);
    
    } catch (err) {
        console.log(err);
        next(err);
    }
}

//Given a (req, res) function, returns
//an Express endpoint that runs it on a synchronous
//co-routine and handles errors
function endpoint(fn) {
    return function (req, res, next) {
        try {
            fn(req, res);
        }
        catch (err) {
            //On error, log it, then return to the client
            console.log('Error handling ' + req.url + ':');
            console.log(err.stack);
            next(err);
        }
    }
}

//Express route that returns a JSON list of replies
var replies = endpoint(function(req, res) {
    //set headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    //Parse the querystring.  We support author_name, from, page
    var params, author_name, from, page, page_size;
    params = url.parse(req.url, true).query;
    author_name = params.author_name;
    from = parseInt(params.from);
    if (params.page) {
        page = parseInt(params.page);
    } else {
        page = 1;
    }
    if (params.page_size) {
        page_size = parseInt(params.page_size);
    } else {
        page_size = 10;
    }
    
    //Sends a 400 message to the client
    function return400 (msg) {
        res.statusCode = 400;
        res.end(msg);
    }
    
    //Validate the parameters
    if (!author_name) {
        return return400('Missing "author_name" parameter in querystring');
    }
    if (Number.isNaN(from)) {
        return return400('Invalid or missing "from" paramater: should be a unix timestamp in miliseconds');
    }
    if (Number.isNaN(page) || page < 1) {
        return return400('Invalid "page" parameter: should be an integer >= 1');
    }
    if (Number.isNaN(page_size) || page_size < 1 || page_size > 100) {
        return return400('Invalid "page_size" parameter: should be an integer between 1 and 100');
    }
    
    //Get a postgres client and do a search for comments that match these parameters
    var rows = withClient(function(client) {
        var limit, offset;
        //Currently we return at most 100 replies per call
        limit = page_size;
        offset = limit * (page - 1);
        
        sql = "SELECT data FROM public.comments WHERE in_reply_to @> ARRAY[$1] AND timestamp > $2 ORDER BY timestamp LIMIT $3 OFFSET $4";
        
        return client.query(sql, [author_name, from, limit, offset]).rows;
    });
    
    //Build the results to return to the client
    var results = [];
    for (var i = 0; i < rows.length; i++) {
        results.push(rows[i].data);
    }
    
    //And send them
    res.end(JSON.stringify(results));
});

//Subscription html page
var HTML = '<html><head><title>SSC Comment Subscriptions</title></head>\n';
HTML += "<body><h3>Subscribe to replies to {author_name}'s comments</h3>\n'
HTML += "<p>If you sign up, you will get an email whenever someone replies to one of {author_name}'s comments,\n"
HTML += 'or includes "@{author_name}" in their comment.  (Comments within a short timespan of each other will be\n
HTML += 'sent in a single email).  You can unsubscribe at any time by clicking a link in the bottom of the notification\n
HTML += 'email.  Please enter your email address to continue:\n</p>'
HTML += '<form method="POST" action="send" enctype="application/x-www-form-urlencoded">\n'
HTML += '<input type="hidden" name="author_name" value="{author_name}"></input>\n'
HTML += '<input type="email" placeholder="email" name="email"></input></form></body></html>'

//Express route that renders the subscription html for a given author_name
function subscribe(req, res) {
    //Extract author_name from the querystring
    var params, author_name;
    params = url.parse(req.url, true).query;
    author_name = params.author_name;
    
    //If missing, send an error
    if (!author_name) {
        res.statusCode = 400;
        res.end('Missing "author_name" parameter in querystring');
        return
    }  
    
    return HTML.replace(/{author_name}/g, author_name);
}

//Generates a random token
function createToken() { return crypto.randomBytes(20).toString('hex'); }

//Track the last time we sent a subscription email to an address
var lastSend = {};

//Track the number of subscription emails to an address
var totalEmails = {};

//Track the total number of subscription emails from this ip
var fromIP = {};

//Express route called by subscription page to send the email verification
var send = endpoint(function(req, res)
    //Extract the author_name and email and send a 400 if either are missing
    var author_name = req.body.author_name;
    var email = req.body.email;
    if (!author_name || !email} {
        res.statusCode = 400;
        res.end('Missing form data: author_name or email');
        return;
    }
    
    //Check if we've already recently sent a subscription email to this address.  If so, no need to send again
    //We define already sent as 30 seconds * 2 ^ number of emails we've already sent to this address
    var alreadySent = lastSend[email] && (Date.now() - lastSend[email] < Math.pow(2, totalEmails[email]) * 30000)
    if (!alreadySent) {
    
        //Rate limit IP addresses to 20 requests per 24 hours
        fromIP[req.ip] = fromIP[req.ip] || 0;
        if (fromIP[req.ip] > 20) {
            res.statusCode = 503;
            res.end('Too many requests');
            return;
        }
        fromIP[req.ip]++;
        setTimeout(function() { 
            fromIP[req.ip]--; 
            if (fromIP[req.ip] === 0) { delete fromIP[req.ip]; }
        }, 24*60*60*1000);
        
        //Update lastSend and totalEmails
        lastSend[email] = Date.now();
        totalEmails[email] = totalEmails[email] ? totalEmails[email] + 1 : 1;
        
        //And clear them in 24 hours
        setTimeout(function() { 
            delete lastSend[email];
            totalEmails[email];
        }, 24*60*60*1000);
        
        //Generate a token to prove ownership of the email and save it to the database
        //with a 24 hour expiration
        var token = createToken();
        var expiration = Date.now() + 24*60*60*1000;
        withClient(function(client) {
            client.query('INSERT INTO public.tokens (id, email, expiration) VALUES ($1, $2, $3)', [token, email, expiration])
        });
        
        //Actually send the email
        console.log('TODO: send email for ' + email + ' ' + author_name + ' with token ' + token);
    }
    
    //Indicate success
    res.end('Verification email sent to ' + email + '.  Check your email to finish the signup process');
});

//Express route called from within an email that verifies ownership and creates
//the subscription
var verify = endpoint(function(req, res) {
    //Extract author_name and token from the querystring
    var params, author_name, token;
    params = url.parse(req.url, true).query;
    author_name = params.author_name;
    token = params.token;
    
    //Validate we have them
    if (!author_name || !token) {
        res.statusCode = 400;
        res.end('Oops, it looks like you did not copy the full link from the email... some information got cut off!');
        return
    }
    
    //In a transaction, verify the token and create the subscription
    transaction(function(client) {
        results = client.query("DELETE FROM public.tokens WHERE id = $1 RETURNING email, expiration", [token]);
        //make sure a) we found the token, and b) it's not expired
        if (results.rows.length < 1 || results.rows[0].expiration < Date.now()) {
            res.statusCode = 400;
            res.end('Oops, it looks like this verification request is expired.  Please send a new request!');
            return
        }
        
        var email = results.rows[0].email;
        
        //Create the subscription
        var id = createToken();
        client.query('INSERT INTO public.subscriptions (id, email, author_name) VALUES ($1, $2, $3)', [id, email, author_name]);
    });
    
    res.end('Thanks, your email address has been verified!  You will now start receiving replies.  To unsubscribe, just click the link in the bottom of any email.');
});

//Express route for unsubscribing from an email subscription
function unsubscribe(req, res) {
    //Extract the subscription id and email from the query string
    var params, id, email;
    params = url.parse(req.url, true).query;
    id = params.id;
    email = params.email;
    
    if (!id || !email) {
        res.statusCode = 400;
        res.end('Oops, it looks like you did not copy the full link from the email... some information got cut off!');
    }
    
    //Delete the subscription with that id and email
    withClient(function(client) {
        client.query('DELETE FROM public.subscriptions WHERE id = $1 and email = $2', [id, email]);
    });
    
    //Report success
    res.end('Email ' + email + ' has been unsubscribed from these notifications');
}


//Starts up our API server
function startServer() {
    var app = express();
    
    //install the various endpoints:
    app.use(bodyParser.urlencoded({extended: false}));
    app.get('/replies', replies);
    app.get('/subscribe', subscribe);
    app.post('/send', send);
    app.get('/unsubscribe', unsubscribe);
    app.get('/', statusEndpoint);
    
    var port = get_config().port;
    
    
    //If we have a an ssl_port defined in our configuration, set up ssl
    //using LetsEncrypt
    var ssl_port = get_config().ssl_port;
    if (ssl_port) {
        var letsEncrypt = get_config().letsEncrypt;
        if (!letsEncrypt) {
            console.log('SSL port specified, but no letsEncrypt settings: expected: domain, prod, email');
            process.exit(1);
        }
        var server;
        if (letsEncrypt.prod) {
            server = 'https://acme-v01.api.letsencrypt.org/directory'
        } else {
            server = 'staging';
            console.log('using letsencrypt staging server -- switch to prod when ready');
        }
        
        //Create a LetsEncrypt wrapper and host it on our http and https port
        greenlock_express.create({
            server: server,
            email: letsEncrypt.email,
            agreeTos: true,
            approveDomains: [letsEncrypt.domain],
            app: app
        }).listen(port, ssl_port);
    
    } else {    
        app.listen(port, function(err) {
            if (err) {
                console.log('Unable to listen on port ' + port + ': ');
                console.log(err);
                process.exit(1);
            }
            console.log('Listening on port ' + port);
        });
    }
    

}


//Reads in the latest comments from the WordPress api, processes them,
//and then persists them to our postgres database
function getLatestComments() {
    //Kick off a synchronous coroutine
    block.run(function() {
        try {
            fetchComments();
            
            //We successfully completed, so do this again in 30 seconds
            setTimeout(getLatestComments, LOAD_COMMENTS_EVERY);
        }
        catch (err) {
            //Record the latest failure for monitoring purposes
            lastError = err;
        
            //Try again in 5 minutes
            console.log('error fetching comments:');
            console.log(err.stack);
            setTimeout(getLatestComments, FAIL_RETRY);
        }
    });
}


//If this file is the entry point, start up our server and begin 
//fetching comments
if (require.main === module) {
    //Confirm we've configured an api base url
    if (!get_config().api_base) {
        console.log('Please set "api_base" in config.json.  E.g., http://slatestarcodex.com');
        process.exit(1);
    }
    //Confirm we've configured a port to listen on
    if (!get_config().port) {
        console.log('Please set "port" in config.json. E.g., 80.');
        process.exit(1);
    }

    startServer();
    getLatestComments();
    
    //if we have an uncaught exception, we want to log it (but not immediately exit)
    process.on('uncaughtException', function (err) {
        console.log('uncaught exception:');
        console.log(err.stack);
    });
}

})()