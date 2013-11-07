var _ = require('underscore'),
    transition = require('../../transitions/registration'),
    sinon = require('sinon'),
    moment = require('moment'),
    utils = require('../../lib/utils'),
    related_entities,
    config;

related_entities = {
    clinic: {
        contact: {
            phone: '+1234'
        }
    }
};

function getMessage(doc) {
    if (!doc || !doc.tasks) return;
    return _.first(_.first(doc.tasks).messages).message;
}

exports.setUp = function(callback) {
    sinon.stub(transition, 'getConfig').returns([{
        form: 'y',
        type: 'pregnancy',
        events: [
           {
               "name": "on_create",
               "trigger": "add_patient_id",
               "params": "",
               "bool_expr": ""
           },
           {
               "name": "on_create",
               "trigger": "add_expected_date",
               "params": "",
               "bool_expr": "typeof doc.getid === 'undefined'"
           }
        ],
        validations: [
            {
                property: 'lmp',
                rule: 'min(0) && max(40)',
                message: 'Invalid LMP; must be between 0-40 weeks.'
            },
            {
                property: 'patient_name',
                rule: 'lenMin(1) && lenMax(100)',
                message: 'Invalid patient name.'
            }
        ]
    }]);
    callback();
};

exports.tearDown = function(callback) {
    if (utils.getRegistrations.restore)
        utils.getRegistrations.restore();

    if (transition.getConfig.restore)
        transition.getConfig.restore();

    callback();
}

exports['filter fails with empty doc'] = function(test) {
    test.ok(_.isFunction(transition.filter));
    test.ok(transition.filter.length >= 1);

    test.equals(transition.filter({}), false);

    test.done();
};

exports['is id only'] = function(test) {
    test.equals(transition.isIdOnly({}), false);
    test.equals(transition.isIdOnly({
        getid: undefined
    }), false);
    test.equals(transition.isIdOnly({
        getid: ''
    }), false);
    test.equals(transition.isIdOnly({
        getid: 'x'
    }), true);
    test.done();
}

exports['setExpectedBirthDate sets lmp_date and expected_date to null when lmp 0'] = function(test) {
    var doc = {lmp: 0};
    transition.setExpectedBirthDate(doc);
    test.equals(doc.lmp_date, null);
    test.equals(doc.expected_date, null);
    test.done();
}

exports['setExpectedBirthDate sets lmp_date and expected_date correctly for lmp: 10'] = function(test) {
    var doc,
        start = moment().startOf('week');

    doc = {
        lmp: '10'
    };

    transition.setExpectedBirthDate(doc);

    test.ok(doc.lmp_date);
    test.equals(doc.lmp_date, start.clone().subtract(10, 'weeks').toISOString());
    test.equals(doc.expected_date, start.clone().add(30, 'weeks').toISOString());

    test.done();
}

exports['valid adds lmp_date and patient_id'] = function(test) {
    test.expect(5);
    var doc,
        start = moment().startOf('week').subtract(5, 'weeks');

    sinon.stub(utils, 'getRegistrations').callsArgWithAsync(1, null, []);

    doc = {
        form: 'y',
        patient_name: 'abc',
        lmp: 5
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.lmp_date, start.toISOString());
        test.ok(doc.patient_id);
        test.equals(doc.tasks, undefined);
        test.done();
    });
}

exports['zero lmp value only registers patient'] = function(test) {

    test.expect(5);

    sinon.stub(utils, 'getRegistrations').callsArgWithAsync(1, null, []);

    var doc = {
        form: 'y',
        patient_name: 'abc',
        lmp: 0
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.lmp_date, null);
        test.ok(doc.patient_id);
        test.equals(doc.tasks, undefined);
        test.done();
    });
}

exports['id only logic with valid name'] = function(test) {
    var doc;

    sinon.stub(utils, 'getRegistrations').callsArgWithAsync(1, null, []);

    doc = {
        form: 'y',
        patient_name: 'abc',
        lmp: 5,
        getid: 'x'
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.lmp_date, undefined);
        test.ok(doc.patient_id);

        test.done();
    });
}

exports['id only logic with invalid name'] = function(test) {
    test.expect(5);
    var doc;

    doc = {
        form: 'y',
        from: '+12345',
        patient_name: '',
        lmp: 5,
        getid: 'x'
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.patient_id, undefined);
        test.ok(doc.tasks);
        test.equals(getMessage(doc), 'Invalid patient name.');

        test.done();
    });
}

exports['invalid name valid LMP logic'] = function(test) {
    test.expect(4);

    var doc;

    doc = {
        form: 'y',
        from: '+1234',
        related_entities: {
            clinic: {
                contact: {
                    phone: '+1234'
                }
            }
        },
        patient_name: '',
        lmp: 5
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.patient_id, undefined);
        test.equals(getMessage(doc), 'Invalid patient name.');

        test.done();
    });
}

exports['valid name invalid LMP logic'] = function(test) {
    var doc;

    doc = {
        form: 'y',
        from: '+1234',
        patient_name: 'hi',
        lmp: 45
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.patient_id, undefined);
        test.equals(getMessage(doc), 'Invalid LMP; must be between 0-40 weeks.');

        test.done();
    });
}

exports['invalid name invalid LMP logic'] = function(test) {
    var doc;

    doc = {
        form: 'y',
        from: '+123',
        patient_name: '',
        lmp: 45
    };

    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(err, null);
        test.equals(complete, true);
        test.equals(doc.patient_id, undefined);
        test.equals(getMessage(doc), 'Invalid patient name.  Invalid LMP; must be between 0-40 weeks.');

        test.done();
    });
}

exports['mismatched form returns false'] = function(test) {
    transition.onMatch({
        doc: {
            form: 'x'
        }
    }, {}, function(err, complete) {
        test.equals(complete, false);

        test.done();
    })
}

exports['missing all fields returns validation errors'] = function(test) {
    test.expect(2);
    var doc = {
        form: 'y',
        from: '+123',
        related_entities: related_entities
    };
    transition.onMatch({
        doc: doc
    }, {}, function(err, complete) {
        test.equals(complete, true);
        test.equals(
            getMessage(doc),
            'Invalid LMP; must be between 0-40 weeks.  Invalid patient name.'
        );
        test.done();
    });
}
