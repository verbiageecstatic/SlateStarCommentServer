
//Retrieves the latest date in the database that we have comments for
function getFromDate(cb) {

}

//Fetches all the comments that have come in since this date,
//and persists them to the database as a single transaction.
//Calls back when finished  
function fetchComments(fromDate, cb) {

}


//Starts up our API server
function startServer() {
    console.log('Pretend we just started a server');
}


//Reads in the latest comments from the WordPress api, processes them,
//and then persists them to our postgres database
function getLatestComments {
    //Get the date to start from
    getFromDate(function(err, fromDate) {
        if (err) { return logAndRestart(err) }
        
        fetchComments(fromDate, function (err) {
            if (err) { return logAndRestart(err) }
            
            //We successfully completed, so do this again in 30 seconds
            setTimeout(getLatestComments, 30*1000);
        });
    });
}

//For errors that occur during the comment fetching process, we want to log them,
//then retry the process in 5 minutes
function logAndRestart (err) {
    console.log('error fetching comments:');
    console.log(err.stack);
    setTimeout(getLatestComments, 5*60*1000);
}


//If this file is the entry point, start up our server and begin 
//fetching comments
if (require.main is module) {
    startServer();
    
    getLatestComments();
    
    //if we have an uncaught exception, we want to log it (but not immediately exit)
    process.on('uncaughtException', function (err) {
        console.log('uncaught exception:');
        console.log(err.stack);
    });
}
