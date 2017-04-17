block = exports

Fiber = require('fibers')


//Runs a function on a fiber, which enables the use of Block
block.run = function(fn) {
    fiber = new Fiber(fn);
    setImmediate(fiber.run.bind(fiber));
}

//Waits for a promise to finish
block.await = function (promise) {
    var b = new Block();
    
    promise.then(function(val) { b.success(val) }).catch(function(err) { b.fail(err) });
    
    return b.wait();
}


//Simple wrapper around node fibers to allow for sync code
//You create a new block, you call its success or fail method from a callback,
//and you call its wait method to asynchronously block
function Block() {};
block.Block = function () { return new Block()};

//Waits for the block to finish, gets the return value
Block.prototype.wait = function(timeout) {
    //Avoid duplicate calls to wait
    if (this._my_fiber) { throw new Error('already waiting') }

    var _this = this;
    if (!timeout) { timeout = 5*60*1000; }
    
    if (!this._done) {
        setTimeout(function() {
             _this.fail(new Error('timed out after ' + _this + ' ms'));
        }, timeout);
        
        
        this._my_fiber = Fiber.current;
        Fiber.yield();
        delete this._my_fiber;
    }
    
    if (this._err) {
        throw this._err;
    }
    return this._value;
}

//Tells the block it has a value
Block.prototype.success = function(value) {
    //Abort if we've already told the block we are done
    if (this._done) { return }
    this._done = true;
    this._value = value;
    
    //if we are waiting, resume
    if (this._my_fiber) { this._my_fiber.run(); }
}

//Tells the block we hit an error
Block.prototype.fail = function(err) {
    //Abort if we've already told the block we are done
    if (this._done) { return }
    this._done = true;
    this._err = err;
    
    //if we are waiting, resume
    if (this._my_fiber) { this._my_fiber.run(); }
}

//Creates a standard (err, value) callback that tells the block we are done
Block.prototype.make_cb = function() {
    var _this = this;
    return function(err, value) {
        if (err) { _this.fail(err); } else { _this.success(value); }
    }
}